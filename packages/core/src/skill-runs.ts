import { and, asc, desc, eq } from "drizzle-orm";
import type { ManagedSkill, SkillRun } from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";
import { evaluateSkillPolicy } from "@wknowledge/skill-runtime";
import { resolveAgentSessionContext } from "./agent-sessions";
import { sessionSkillExecution } from "./session-skill-execution";

function sameBindingIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

export function presentSkillRun(input: typeof schema.skillRuns.$inferSelect): SkillRun {
  return {
    id: input.id,
    sessionId: input.sessionId,
    skillId: input.skillId,
    skillVersion: input.skillVersion,
    skillDigest: input.skillDigest,
    bindingIds: input.bindingIds,
    approvalId: input.approvalId,
    inputSummary: input.inputSummary,
    status: input.status,
    errorCode: input.errorCode,
    outputSummary: input.outputSummary as Record<string, string | number | boolean> | null,
    queuedAt: input.queuedAt.toISOString(),
    startedAt: input.startedAt?.toISOString() ?? null,
    completedAt: input.completedAt?.toISOString() ?? null
  };
}

export async function createQueuedSkillRun(input: {
  sessionId: string;
  userId: string;
  skill: ManagedSkill;
  bindingIds: string[];
  inputSummary: string;
  learningGeneration?: {
    kind: "plan_compose" | "practice_generate";
    input: Record<string, unknown>;
  };
}) {
  if (sessionSkillExecution(input.skill) !== "worker")
    throw new Error("SKILL_EXECUTION_UNAVAILABLE");
  if (
    input.learningGeneration &&
    input.skill.id !==
      (input.learningGeneration.kind === "plan_compose" ? "plan-compose" : "practice-generate")
  )
    throw new Error("LEARNING_GENERATION_SKILL_INVALID");
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
  const approvals =
    policy.decision === "ask"
      ? await getDatabase()
          .select()
          .from(schema.skillApprovals)
          .where(
            and(
              eq(schema.skillApprovals.sessionId, input.sessionId),
              eq(schema.skillApprovals.userId, input.userId),
              eq(schema.skillApprovals.skillId, input.skill.id),
              eq(schema.skillApprovals.skillVersion, input.skill.version),
              eq(schema.skillApprovals.skillDigest, input.skill.digest),
              eq(schema.skillApprovals.status, "approved")
            )
          )
          .orderBy(desc(schema.skillApprovals.decidedAt))
          .limit(20)
      : [];
  const approval = approvals.find(
    (candidate) =>
      candidate.expiresAt > new Date() &&
      candidate.inputSummary === input.inputSummary &&
      sameBindingIds(candidate.bindingIds, input.bindingIds)
  );
  if (policy.decision === "ask" && !approval) throw new Error("SKILL_APPROVAL_REQUIRED");
  const run = await getDatabase().transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.skillRuns)
      .values({
        sessionId: input.sessionId,
        userId: input.userId,
        skillId: input.skill.id,
        skillVersion: input.skill.version,
        skillDigest: input.skill.digest,
        bindingIds: input.bindingIds,
        approvalId: approval?.id ?? null,
        inputSummary: input.inputSummary
      })
      .returning();
    if (!created) throw new Error("SKILL_RUN_CREATE_FAILED");
    if (input.learningGeneration)
      await tx.insert(schema.learningGenerationRequests).values({
        skillRunId: created.id,
        kind: input.learningGeneration.kind,
        input: input.learningGeneration.input
      });
    await tx.insert(schema.skillRunOutbox).values({ skillRunId: created.id });
    return created;
  });
  if (!run) throw new Error("SKILL_RUN_CREATE_FAILED");
  await getDatabase()
    .insert(schema.auditEvents)
    .values({
      organizationId: context.session.organizationId,
      actorUserId: input.userId,
      action: "skill_run.queued",
      targetType: "skill_run",
      targetId: run.id,
      metadata: {
        skillId: run.skillId,
        bindingCount: run.bindingIds.length,
        approvalId: run.approvalId
      }
    });
  return presentSkillRun(run);
}

export async function getSkillRun(runId: string, userId: string) {
  const [run] = await getDatabase()
    .select({ run: schema.skillRuns, session: schema.agentSessions })
    .from(schema.skillRuns)
    .innerJoin(schema.agentSessions, eq(schema.skillRuns.sessionId, schema.agentSessions.id))
    .where(and(eq(schema.skillRuns.id, runId), eq(schema.agentSessions.userId, userId)))
    .limit(1);
  if (!run) throw new Error("SKILL_RUN_NOT_FOUND");
  return presentSkillRun(run.run);
}

export async function listSessionSkillRuns(sessionId: string, userId: string) {
  await resolveAgentSessionContext(sessionId, userId);
  const rows = await getDatabase()
    .select()
    .from(schema.skillRuns)
    .where(eq(schema.skillRuns.sessionId, sessionId))
    .orderBy(asc(schema.skillRuns.queuedAt));
  return rows.map(presentSkillRun);
}
