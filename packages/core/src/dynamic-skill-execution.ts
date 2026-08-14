import { and, eq } from "drizzle-orm";
import { rm } from "node:fs/promises";
import {
  createSkillSandboxDirectories,
  evaluateSkillPolicy,
  executeDynamicSkillSandbox,
  resolveManagedDynamicSkill,
  type DynamicSkillSandboxExecution,
  type DynamicSkillSandboxRuntime,
  writeSkillSandboxInput
} from "@wknowledge/skill-runtime";
import {
  planComposeCandidateOutputSchema,
  practiceGenerateCandidateOutputSchema
} from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";
import { resolveAgentSessionContext } from "./agent-sessions";

const STABLE_EXECUTION_CODES = new Set([
  "AGENT_SESSION_NOT_FOUND",
  "SKILL_MANIFEST_CHANGED",
  "SKILL_INSTALLATION_CHANGED",
  "SKILL_SCOPE_REVOKED",
  "SKILL_POLICY_REVOKED",
  "SKILL_APPROVAL_REVOKED",
  "SKILL_SANDBOX_ENTRYPOINT_INVALID",
  "SKILL_SANDBOX_INPUT_INVALID",
  "SKILL_SANDBOX_INPUT_TOO_LARGE",
  "SKILL_IO_SCHEMA_INVALID",
  "SKILL_SANDBOX_RUNTIME_UNAVAILABLE",
  "SKILL_SANDBOX_PROCESS_FAILED",
  "SKILL_SANDBOX_PROCESS_TIMED_OUT",
  "SKILL_SANDBOX_PROCESS_CANCELLED",
  "SKILL_SANDBOX_RESULT_INVALID",
  "SKILL_SANDBOX_RESULT_TOO_LARGE",
  "SKILL_SANDBOX_NETWORK_UNSUPPORTED",
  "SKILL_SANDBOX_MODEL_UNSUPPORTED",
  "SKILL_ENTRYPOINT_DENIED",
  "PLAN_COMPOSE_CANDIDATE_INVALID",
  "PLAN_COMPOSE_CANDIDATE_EXISTS",
  "PRACTICE_GENERATE_CANDIDATE_INVALID",
  "PRACTICE_GENERATE_CANDIDATE_EXISTS",
  "PRACTICE_GENERATE_SCOPE_DENIED"
]);

type DynamicSkillSandboxExecutor = (
  input: Parameters<typeof executeDynamicSkillSandbox>[0]
) => Promise<DynamicSkillSandboxExecution>;

function normalizedExecutionCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return STABLE_EXECUTION_CODES.has(message) ? message : "SKILL_SANDBOX_EXECUTION_FAILED";
}

function outputShapeSummary(output: unknown): Record<string, string | number | boolean> {
  if (Array.isArray(output)) return { outputType: "array", outputItemCount: output.length };
  if (output && typeof output === "object") {
    return { outputType: "object", outputKeyCount: Object.keys(output).length };
  }
  return { outputType: output === null ? "null" : typeof output };
}

export async function persistPlanComposeCandidate(input: {
  run: typeof schema.skillRuns.$inferSelect;
  output: unknown;
}) {
  if (input.run.skillId !== "plan-compose") return;
  const parsed = planComposeCandidateOutputSchema.safeParse(input.output);
  if (!parsed.success) throw new Error("PLAN_COMPOSE_CANDIDATE_INVALID");
  const [existing] = await getDatabase()
    .select({ id: schema.planComposeCandidates.id })
    .from(schema.planComposeCandidates)
    .where(eq(schema.planComposeCandidates.skillRunId, input.run.id))
    .limit(1);
  if (existing) throw new Error("PLAN_COMPOSE_CANDIDATE_EXISTS");
  await getDatabase().insert(schema.planComposeCandidates).values({
    skillRunId: input.run.id,
    userId: input.run.userId,
    candidate: parsed.data
  });
}

export async function persistPracticeGenerateCandidate(input: {
  run: typeof schema.skillRuns.$inferSelect;
  output: unknown;
  bindings: Array<{
    scope: string;
    targetId: string | null;
    courseResourceVersionIds?: string[];
  }>;
}) {
  if (input.run.skillId !== "practice-generate") return;
  const parsed = practiceGenerateCandidateOutputSchema.safeParse(input.output);
  if (!parsed.success) throw new Error("PRACTICE_GENERATE_CANDIDATE_INVALID");
  const courseBindings = input.bindings.filter(
    (binding) => binding.scope === "course" && binding.targetId === parsed.data.courseId
  );
  if (!courseBindings.length) throw new Error("PRACTICE_GENERATE_SCOPE_DENIED");
  const allowedResourceVersionIds = new Set(
    courseBindings.flatMap(({ courseResourceVersionIds }) => courseResourceVersionIds ?? [])
  );
  if (
    parsed.data.questions.some(
      ({ resourceVersionId }) => !allowedResourceVersionIds.has(resourceVersionId)
    )
  )
    throw new Error("PRACTICE_GENERATE_SCOPE_DENIED");
  const [existing] = await getDatabase()
    .select({ id: schema.practiceGenerateCandidates.id })
    .from(schema.practiceGenerateCandidates)
    .where(eq(schema.practiceGenerateCandidates.skillRunId, input.run.id))
    .limit(1);
  if (existing) throw new Error("PRACTICE_GENERATE_CANDIDATE_EXISTS");
  await getDatabase().insert(schema.practiceGenerateCandidates).values({
    skillRunId: input.run.id,
    userId: input.run.userId,
    candidate: parsed.data
  });
}

async function matchingApproval(input: {
  approvalId: string | null;
  run: typeof schema.skillRuns.$inferSelect;
}): Promise<boolean> {
  if (!input.approvalId) return false;
  const [approval] = await getDatabase()
    .select()
    .from(schema.skillApprovals)
    .where(eq(schema.skillApprovals.id, input.approvalId))
    .limit(1);
  return Boolean(
    approval &&
    approval.status === "approved" &&
    approval.expiresAt > new Date() &&
    approval.sessionId === input.run.sessionId &&
    approval.userId === input.run.userId &&
    approval.skillId === input.run.skillId &&
    approval.skillVersion === input.run.skillVersion &&
    approval.skillDigest === input.run.skillDigest &&
    approval.inputSummary === input.run.inputSummary &&
    approval.bindingIds.length === input.run.bindingIds.length &&
    approval.bindingIds.every((bindingId) => input.run.bindingIds.includes(bindingId))
  );
}

export async function executeDynamicSkillRun(input: {
  skillRunId: string;
  installedSkillsRoot: string;
  sandboxRoot: string;
  runtime: DynamicSkillSandboxRuntime;
  sandboxExecutor?: DynamicSkillSandboxExecutor;
}) {
  const db = getDatabase();
  const [candidate] = await db
    .select({ skillId: schema.skillRuns.skillId, status: schema.skillRuns.status })
    .from(schema.skillRuns)
    .where(eq(schema.skillRuns.id, input.skillRunId))
    .limit(1);
  if (!candidate || candidate.status !== "queued")
    return { handled: false, status: "terminal_or_claimed" as const };
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
  let errorCode: string | null = null;
  let outputSummary: Record<string, string | number | boolean> | null = null;
  let sandboxRoot: string | null = null;
  try {
    if (!session) throw new Error("AGENT_SESSION_NOT_FOUND");
    const context = await resolveAgentSessionContext(run.sessionId, run.userId);
    const { manifest, program } = await resolveManagedDynamicSkill({
      installedSkillsRoot: input.installedSkillsRoot,
      skillId: run.skillId
    });
    if (manifest.version !== run.skillVersion || manifest.digest !== run.skillDigest)
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
    if (run.bindingIds.some((bindingId) => !activeBindingIds.has(bindingId)))
      throw new Error("SKILL_SCOPE_REVOKED");
    const policy = evaluateSkillPolicy({
      manifest,
      enabled: installation?.enabled ?? true,
      activeBindingIds: [...activeBindingIds],
      requestedBindingIds: run.bindingIds,
      bindingScopes: new Map(context.bindings.map(({ id, scope }) => [id, scope]))
    });
    if (policy.decision === "deny") throw new Error("SKILL_POLICY_REVOKED");
    if (policy.decision === "ask" && !(await matchingApproval({ approvalId: run.approvalId, run })))
      throw new Error("SKILL_APPROVAL_REVOKED");
    const bindings = context.bindings
      .filter(({ id }) => run.bindingIds.includes(id))
      .map(({ id, scope, spaceId, virtualPath }) => ({ id, scope, spaceId, virtualPath }));
    const sandbox = await createSkillSandboxDirectories({
      sandboxRoot: input.sandboxRoot,
      skillRunId: run.id
    });
    sandboxRoot = sandbox.root;
    await writeSkillSandboxInput({
      sandbox,
      schema: manifest.inputSchema,
      input: { schemaVersion: 1, skillRunId: run.id, bindings }
    });
    const execution = await (input.sandboxExecutor ?? executeDynamicSkillSandbox)({
      manifest,
      sandbox,
      program,
      runtime: input.runtime,
      outputSchema: manifest.outputSchema
    });
    if (execution.status === "failed") throw new Error(execution.errorCode);
    await persistPlanComposeCandidate({ run, output: execution.output });
    await persistPracticeGenerateCandidate({
      run,
      output: execution.output,
      bindings: context.bindings
    });
    outputSummary = {
      runtime: manifest.entrypoint === "typescript-json-cli" ? "node" : "python",
      bindingCount: bindings.length,
      durationMs: execution.durationMs,
      networkCalls: 0,
      modelCalls: 0,
      ...outputShapeSummary(execution.output)
    };
  } catch (error) {
    errorCode = normalizedExecutionCode(error);
  } finally {
    if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  const status = errorCode ? "failed" : "completed";
  await db.transaction(async (tx) => {
    await tx
      .update(schema.skillRuns)
      .set({ status, errorCode, outputSummary, completedAt: new Date() })
      .where(and(eq(schema.skillRuns.id, run.id), eq(schema.skillRuns.status, "running")));
    if (session) {
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
    }
  });
  return { handled: true, status, errorCode, outputSummary };
}
