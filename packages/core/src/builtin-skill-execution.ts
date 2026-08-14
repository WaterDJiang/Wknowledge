import { and, eq } from "drizzle-orm";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { evaluateSkillPolicy, loadSkillManifest } from "@wknowledge/skill-runtime";
import { lintWikiDirectory } from "@wknowledge/wiki";
import { getDatabase, schema } from "@wknowledge/database";
import { resolveAgentSessionContext } from "./agent-sessions";

const supportedSkillId = "wiki-lint";

async function resolveReadOnlyWikiDirectory(dataRoot: string, spaceId: string): Promise<string> {
  if (!/^[0-9a-f-]{36}$/i.test(spaceId)) throw new Error("SKILL_SPACE_ID_INVALID");
  let resolvedDataRoot: string;
  try {
    resolvedDataRoot = await realpath(dataRoot);
  } catch {
    throw new Error("SKILL_DATA_ROOT_UNAVAILABLE");
  }
  let root: string;
  try {
    root = await realpath(path.join(resolvedDataRoot, spaceId, "wiki"));
  } catch {
    throw new Error("SKILL_PATH_DENIED");
  }
  if (!root.startsWith(`${resolvedDataRoot}${path.sep}`)) throw new Error("SKILL_PATH_DENIED");
  return root;
}

export async function executeBuiltinSkillRun(input: {
  skillRunId: string;
  dataRoot: string;
  builtinSkillsRoot: string;
}) {
  const db = getDatabase();
  const [candidate] = await db
    .select({ skillId: schema.skillRuns.skillId, status: schema.skillRuns.status })
    .from(schema.skillRuns)
    .where(eq(schema.skillRuns.id, input.skillRunId))
    .limit(1);
  if (!candidate || candidate.status !== "queued")
    return { handled: false, status: "terminal_or_claimed" as const };
  if (candidate.skillId !== supportedSkillId)
    return { handled: false, status: "not_builtin" as const };
  const [run] = await db
    .update(schema.skillRuns)
    .set({ status: "running", startedAt: new Date(), errorCode: null, outputSummary: null })
    .where(and(eq(schema.skillRuns.id, input.skillRunId), eq(schema.skillRuns.status, "queued")))
    .returning();
  if (!run) return { handled: false, status: "terminal_or_claimed" as const };
  const [session] = await db
    .select({ organizationId: schema.agentSessions.organizationId })
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, run.sessionId))
    .limit(1);
  if (!session) {
    await db
      .update(schema.skillRuns)
      .set({ status: "failed", errorCode: "AGENT_SESSION_NOT_FOUND", completedAt: new Date() })
      .where(and(eq(schema.skillRuns.id, run.id), eq(schema.skillRuns.status, "running")));
    return { handled: true, status: "failed" as const, errorCode: "AGENT_SESSION_NOT_FOUND" };
  }
  let errorCode: string | null = null;
  let outputSummary: Record<string, string | number | boolean> | null = null;
  try {
    const context = await resolveAgentSessionContext(run.sessionId, run.userId);
    const manifest = await loadSkillManifest(path.join(input.builtinSkillsRoot, run.skillId));
    if (
      manifest.id !== run.skillId ||
      manifest.version !== run.skillVersion ||
      manifest.digest !== run.skillDigest
    )
      throw new Error("SKILL_MANIFEST_CHANGED");
    const [installation] = await db
      .select()
      .from(schema.skillInstallations)
      .where(
        and(
          eq(schema.skillInstallations.organizationId, context.session.organizationId),
          eq(schema.skillInstallations.skillId, run.skillId)
        )
      )
      .limit(1);
    if (
      installation &&
      (!installation.enabled ||
        installation.version !== run.skillVersion ||
        installation.digest !== run.skillDigest)
    )
      throw new Error("SKILL_INSTALLATION_CHANGED");
    const activeBindingIds = new Set(context.bindings.map(({ id }) => id));
    if (!run.bindingIds.length || run.bindingIds.some((id) => !activeBindingIds.has(id)))
      throw new Error("SKILL_SCOPE_REVOKED");
    const policy = evaluateSkillPolicy({
      manifest,
      enabled: installation?.enabled ?? true,
      activeBindingIds: [...activeBindingIds],
      requestedBindingIds: run.bindingIds,
      bindingScopes: new Map(context.bindings.map(({ id, scope }) => [id, scope]))
    });
    if (policy.decision !== "allow") throw new Error("SKILL_POLICY_REVOKED");
    if (
      manifest.permissions.network !== "deny" ||
      manifest.permissions.filesystem !== "read" ||
      manifest.requiredCapabilities.length !== 0
    )
      throw new Error("SKILL_EXECUTION_PERMISSION_DENIED");
    const spaces = context.bindings.filter(({ id }) => run.bindingIds.includes(id));
    if (spaces.some(({ scope }) => scope !== "space")) throw new Error("SKILL_SCOPE_UNSUPPORTED");
    let issueCount = 0;
    for (const space of spaces) {
      const root = await resolveReadOnlyWikiDirectory(input.dataRoot, space.spaceId);
      issueCount += (await lintWikiDirectory(root)).length;
    }
    outputSummary = { scannedSpaces: spaces.length, issueCount, networkCalls: 0, modelCalls: 0 };
  } catch (error) {
    errorCode = error instanceof Error ? error.message : "SKILL_EXECUTION_FAILED";
  }
  const status = errorCode ? "failed" : "completed";
  await db.transaction(async (tx) => {
    await tx
      .update(schema.skillRuns)
      .set({ status, errorCode, outputSummary, completedAt: new Date() })
      .where(and(eq(schema.skillRuns.id, run.id), eq(schema.skillRuns.status, "running")));
    await tx.insert(schema.auditEvents).values({
      organizationId: session.organizationId,
      actorUserId: run.userId,
      action: `skill_run.${status}`,
      targetType: "skill_run",
      targetId: run.id,
      metadata: {
        skillId: run.skillId,
        ...(outputSummary ?? {}),
        ...(errorCode ? { errorCode } : {})
      }
    });
  });
  return { handled: true, status, errorCode, outputSummary };
}
