import { and, asc, eq, inArray, lt } from "drizzle-orm";
import type { ManagedSkill, SessionSkill, SkillApproval } from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";
import { evaluateSkillPolicy } from "@wknowledge/skill-runtime";
import { resolveAgentSessionContext } from "./agent-sessions";
import { sessionSkillExecution } from "./session-skill-execution";

const APPROVAL_TTL_MS = 10 * 60 * 1_000;

function requestedBindingIdsForSkill(
  skill: Pick<ManagedSkill, "permissions">,
  bindings: Array<{ id: string; scope: "space" | "wiki_page" | "resource_version" | "course" }>
): string[] {
  if (skill.permissions.resources === "none") return [];
  if (skill.permissions.resources === "space")
    return bindings.filter(({ scope }) => scope === "space").map(({ id }) => id);
  return bindings.map(({ id }) => id);
}

export function presentSkillApproval(
  input: typeof schema.skillApprovals.$inferSelect
): SkillApproval {
  return {
    id: input.id,
    sessionId: input.sessionId,
    skillId: input.skillId,
    skillVersion: input.skillVersion,
    skillDigest: input.skillDigest,
    bindingIds: input.bindingIds,
    inputSummary: input.inputSummary,
    status: input.status,
    expiresAt: input.expiresAt.toISOString(),
    decidedAt: input.decidedAt?.toISOString() ?? null,
    createdAt: input.createdAt.toISOString()
  };
}

export async function listSessionSkillPolicies(input: {
  sessionId: string;
  userId: string;
  skills: ManagedSkill[];
}) {
  const context = await resolveAgentSessionContext(input.sessionId, input.userId);
  const activeBindingIds = context.bindings.map(({ id }) => id);
  const bindingScopes = new Map(context.bindings.map(({ id, scope }) => [id, scope]));
  return input.skills
    .map((skill) => {
      const requestedBindingIds = requestedBindingIdsForSkill(skill, context.bindings);
      const policy = evaluateSkillPolicy({
        manifest: skill,
        enabled: skill.enabled,
        activeBindingIds,
        requestedBindingIds,
        bindingScopes
      });
      return { ...skill, ...policy, execution: sessionSkillExecution(skill) };
    })
    .filter(({ decision }) => decision !== "deny") satisfies SessionSkill[];
}

export async function listSessionSkillApprovals(input: { sessionId: string; userId: string }) {
  await resolveAgentSessionContext(input.sessionId, input.userId);
  const now = new Date();
  const rows = await getDatabase().transaction(async (tx) => {
    await tx
      .update(schema.skillApprovals)
      .set({ status: "expired" })
      .where(
        and(
          eq(schema.skillApprovals.sessionId, input.sessionId),
          eq(schema.skillApprovals.status, "pending"),
          lt(schema.skillApprovals.expiresAt, now)
        )
      );
    return tx
      .select()
      .from(schema.skillApprovals)
      .where(eq(schema.skillApprovals.sessionId, input.sessionId))
      .orderBy(asc(schema.skillApprovals.createdAt));
  });
  return rows.map(presentSkillApproval);
}

export async function requestSkillApproval(input: {
  sessionId: string;
  userId: string;
  skill: ManagedSkill;
  bindingIds: string[];
  inputSummary: string;
}) {
  const context = await resolveAgentSessionContext(input.sessionId, input.userId);
  const bindingScopes = new Map(context.bindings.map(({ id, scope }) => [id, scope]));
  const policy = evaluateSkillPolicy({
    manifest: input.skill,
    enabled: input.skill.enabled,
    activeBindingIds: context.bindings.map(({ id }) => id),
    requestedBindingIds: input.bindingIds,
    bindingScopes
  });
  if (policy.decision === "deny") throw new Error("SKILL_POLICY_DENIED");
  if (policy.decision === "allow") throw new Error("SKILL_APPROVAL_NOT_REQUIRED");
  const [approval] = await getDatabase()
    .insert(schema.skillApprovals)
    .values({
      sessionId: input.sessionId,
      userId: input.userId,
      skillId: input.skill.id,
      skillVersion: input.skill.version,
      skillDigest: input.skill.digest,
      bindingIds: input.bindingIds,
      inputSummary: input.inputSummary,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS)
    })
    .returning();
  if (!approval) throw new Error("SKILL_APPROVAL_CREATE_FAILED");
  await getDatabase()
    .insert(schema.auditEvents)
    .values({
      organizationId: context.session.organizationId,
      actorUserId: input.userId,
      action: "skill_approval.requested",
      targetType: "skill_approval",
      targetId: approval.id,
      metadata: { skillId: input.skill.id, bindingCount: input.bindingIds.length }
    });
  return presentSkillApproval(approval);
}

export async function decideSkillApproval(input: {
  approvalId: string;
  userId: string;
  decision: "approve" | "reject";
}) {
  return getDatabase().transaction(async (tx) => {
    const [current] = await tx
      .select({ approval: schema.skillApprovals, session: schema.agentSessions })
      .from(schema.skillApprovals)
      .innerJoin(schema.agentSessions, eq(schema.skillApprovals.sessionId, schema.agentSessions.id))
      .where(
        and(
          eq(schema.skillApprovals.id, input.approvalId),
          eq(schema.agentSessions.userId, input.userId)
        )
      )
      .for("update")
      .limit(1);
    if (!current) throw new Error("SKILL_APPROVAL_NOT_FOUND");
    if (current.approval.status !== "pending") throw new Error("SKILL_APPROVAL_ALREADY_DECIDED");
    if (current.approval.expiresAt <= new Date()) {
      await tx
        .update(schema.skillApprovals)
        .set({ status: "expired" })
        .where(eq(schema.skillApprovals.id, current.approval.id));
      throw new Error("SKILL_APPROVAL_EXPIRED");
    }
    if (current.session.status !== "active") throw new Error("AGENT_SESSION_ARCHIVED");
    const activeBindings = current.approval.bindingIds.length
      ? await tx
          .select({ id: schema.agentContextBindings.id })
          .from(schema.agentContextBindings)
          .innerJoin(
            schema.spaceMemberships,
            and(
              eq(schema.agentContextBindings.spaceId, schema.spaceMemberships.spaceId),
              eq(schema.spaceMemberships.userId, input.userId)
            )
          )
          .where(
            and(
              eq(schema.agentContextBindings.sessionId, current.session.id),
              eq(schema.agentContextBindings.status, "active"),
              inArray(schema.agentContextBindings.id, current.approval.bindingIds)
            )
          )
      : [];
    if (activeBindings.length !== current.approval.bindingIds.length) {
      await tx
        .update(schema.skillApprovals)
        .set({ status: "expired" })
        .where(eq(schema.skillApprovals.id, current.approval.id));
      throw new Error("SKILL_APPROVAL_SCOPE_REVOKED");
    }
    const [approval] = await tx
      .update(schema.skillApprovals)
      .set({
        status: input.decision === "approve" ? "approved" : "rejected",
        decidedAt: new Date()
      })
      .where(eq(schema.skillApprovals.id, current.approval.id))
      .returning();
    if (!approval) throw new Error("SKILL_APPROVAL_NOT_FOUND");
    await tx.insert(schema.auditEvents).values({
      organizationId: current.session.organizationId,
      actorUserId: input.userId,
      action: input.decision === "approve" ? "skill_approval.approved" : "skill_approval.rejected",
      targetType: "skill_approval",
      targetId: approval.id,
      metadata: { skillId: approval.skillId }
    });
    return presentSkillApproval(approval);
  });
}
