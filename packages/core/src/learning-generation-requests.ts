import type {
  ManagedSkill,
  RequestPlanComposeGenerationInput,
  RequestPracticeGenerateInput,
  SkillRun
} from "@wknowledge/contracts";
import {
  requestPlanComposeGenerationInputSchema,
  requestPracticeGenerateInputSchema
} from "@wknowledge/contracts";
import { and, eq, inArray } from "drizzle-orm";
import { getDatabase, schema } from "@wknowledge/database";
import { createAgentSession, resolveAgentSessionContext } from "./agent-sessions";
import {
  getActiveLearningCourse,
  getActiveLearningProgress,
  listLearningContentOptions
} from "./learning-plans";
import { createQueuedSkillRun } from "./skill-runs";

const PLAN_COMPOSE_INPUT_SUMMARY = "生成计划候选：已选择资料";

async function cleanupFailedGenerationSession(input: { sessionId: string; userId: string }) {
  const db = getDatabase();
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.targetType, "agent_session"),
          eq(schema.auditEvents.targetId, input.sessionId),
          eq(schema.auditEvents.actorUserId, input.userId),
          eq(schema.auditEvents.action, "agent_session.created")
        )
      );
    await tx
      .delete(schema.agentSessions)
      .where(
        and(
          eq(schema.agentSessions.id, input.sessionId),
          eq(schema.agentSessions.userId, input.userId)
        )
      );
  });
}

export async function queuePlanComposeGeneration(
  input: RequestPlanComposeGenerationInput & {
    userId: string;
    skill: ManagedSkill;
  }
): Promise<SkillRun> {
  const parsed = requestPlanComposeGenerationInputSchema.parse(input);
  if (input.skill.id !== "plan-compose") throw new Error("LEARNING_GENERATION_SKILL_INVALID");
  if (new Set(parsed.resourceVersionIds).size !== parsed.resourceVersionIds.length)
    throw new Error("LEARNING_GENERATION_SELECTION_DUPLICATE");

  const options = await listLearningContentOptions(input.userId);
  const optionByVersionId = new Map(
    options.map((option) => [option.resourceVersionId, option] as const)
  );
  const selected = parsed.resourceVersionIds.map((id) => optionByVersionId.get(id));
  if (selected.some((option) => !option)) throw new Error("LEARNING_GENERATION_SELECTION_DENIED");

  let sessionId: string | undefined;
  try {
    const session = await createAgentSession({
      userId: input.userId,
      title: "生成学习计划候选",
      bindings: selected.map((option) => ({
        spaceId: option!.spaceId,
        scope: "resource_version" as const,
        targetId: option!.resourceVersionId
      }))
    });
    sessionId = session.id;
    const context = await resolveAgentSessionContext(session.id, input.userId);
    const bindingByResourceVersionId = new Map(
      context.bindings
        .filter(({ scope }) => scope === "resource_version")
        .map(({ id, targetId }) => [targetId, id] as const)
    );
    const bindingIds = parsed.resourceVersionIds.map((id) => bindingByResourceVersionId.get(id));
    if (bindingIds.some((id) => !id)) throw new Error("LEARNING_GENERATION_BINDING_INVALID");
    return await createQueuedSkillRun({
      sessionId: session.id,
      userId: input.userId,
      skill: input.skill,
      bindingIds: bindingIds as string[],
      inputSummary: `${PLAN_COMPOSE_INPUT_SUMMARY} ${parsed.resourceVersionIds.length} 份`,
      learningGeneration: {
        kind: "plan_compose",
        input: parsed
      }
    });
  } catch (error) {
    if (sessionId) await cleanupFailedGenerationSession({ sessionId, userId: input.userId });
    throw error;
  }
}

export async function getPlanComposeGenerationRequestForRun(skillRunId: string) {
  const [row] = await getDatabase()
    .select({ request: schema.learningGenerationRequests, run: schema.skillRuns })
    .from(schema.learningGenerationRequests)
    .innerJoin(
      schema.skillRuns,
      eq(schema.learningGenerationRequests.skillRunId, schema.skillRuns.id)
    )
    .where(eq(schema.learningGenerationRequests.skillRunId, skillRunId))
    .limit(1);
  if (!row || row.run.skillId !== "plan-compose" || row.request.kind !== "plan_compose")
    throw new Error("LEARNING_GENERATION_REQUEST_NOT_FOUND");
  const input = requestPlanComposeGenerationInputSchema.safeParse(row.request.input);
  if (!input.success) throw new Error("LEARNING_GENERATION_REQUEST_INVALID");
  return {
    skillRunId: row.run.id,
    sessionId: row.run.sessionId,
    userId: row.run.userId,
    input: input.data
  };
}

export async function getPracticeGenerateGenerationRequestForRun(skillRunId: string) {
  const [row] = await getDatabase()
    .select({ request: schema.learningGenerationRequests, run: schema.skillRuns })
    .from(schema.learningGenerationRequests)
    .innerJoin(
      schema.skillRuns,
      eq(schema.learningGenerationRequests.skillRunId, schema.skillRuns.id)
    )
    .where(eq(schema.learningGenerationRequests.skillRunId, skillRunId))
    .limit(1);
  if (!row || row.run.skillId !== "practice-generate" || row.request.kind !== "practice_generate")
    throw new Error("LEARNING_GENERATION_REQUEST_NOT_FOUND");
  const input = requestPracticeGenerateInputSchema.safeParse(row.request.input);
  if (!input.success) throw new Error("LEARNING_GENERATION_REQUEST_INVALID");
  return {
    skillRunId: row.run.id,
    sessionId: row.run.sessionId,
    userId: row.run.userId,
    input: input.data
  };
}

export async function queuePracticeGenerateGeneration(
  input: RequestPracticeGenerateInput & { userId: string; skill: ManagedSkill }
): Promise<SkillRun> {
  const parsed = requestPracticeGenerateInputSchema.parse(input);
  if (input.skill.id !== "practice-generate") throw new Error("LEARNING_GENERATION_SKILL_INVALID");
  if (new Set(parsed.courseUnitIds).size !== parsed.courseUnitIds.length)
    throw new Error("PRACTICE_GENERATE_SELECTION_DUPLICATE");
  const [course, progress] = await Promise.all([
    getActiveLearningCourse(input.userId),
    getActiveLearningProgress(input.userId)
  ]);
  const completedPlanUnitIds = new Set(
    progress.filter(({ completedAt }) => completedAt).map(({ id }) => id)
  );
  const courseUnits = course.modules.flatMap(({ units }) => units);
  const selected = parsed.courseUnitIds.map((id) => courseUnits.find((unit) => unit.id === id));
  if (selected.some((unit) => !unit)) throw new Error("PRACTICE_GENERATE_COURSE_UNIT_DENIED");
  if (selected.some((unit) => !completedPlanUnitIds.has(unit!.planUnitId)))
    throw new Error("PRACTICE_GENERATE_COURSE_UNIT_NOT_COMPLETED");
  const rows = await getDatabase()
    .select({ courseUnitId: schema.courseUnits.id, spaceId: schema.knowledgeSpaces.id })
    .from(schema.courseUnits)
    .innerJoin(schema.courseModules, eq(schema.courseUnits.courseModuleId, schema.courseModules.id))
    .innerJoin(
      schema.resourceVersions,
      eq(schema.courseUnits.resourceVersionId, schema.resourceVersions.id)
    )
    .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
    .innerJoin(schema.knowledgeSpaces, eq(schema.resources.spaceId, schema.knowledgeSpaces.id))
    .where(
      and(
        eq(schema.courseModules.courseId, course.id),
        inArray(schema.courseUnits.id, parsed.courseUnitIds),
        eq(schema.resources.status, "ready")
      )
    );
  if (rows.length !== parsed.courseUnitIds.length)
    throw new Error("PRACTICE_GENERATE_COURSE_UNIT_DENIED");
  const spaceIds = [...new Set(rows.map(({ spaceId }) => spaceId))];
  let sessionId: string | undefined;
  try {
    const session = await createAgentSession({
      userId: input.userId,
      title: "生成针对性练习候选",
      bindings: spaceIds.map((spaceId) => ({
        spaceId,
        scope: "course" as const,
        targetId: course.id
      }))
    });
    sessionId = session.id;
    const context = await resolveAgentSessionContext(session.id, input.userId);
    const bindingIds = context.bindings
      .filter(({ scope, targetId }) => scope === "course" && targetId === course.id)
      .map(({ id }) => id);
    if (bindingIds.length !== spaceIds.length)
      throw new Error("LEARNING_GENERATION_BINDING_INVALID");
    return await createQueuedSkillRun({
      sessionId: session.id,
      userId: input.userId,
      skill: input.skill,
      bindingIds,
      inputSummary: `生成针对性练习候选：${parsed.courseUnitIds.length} 个已完成单元 · ${parsed.difficulty}`,
      learningGeneration: { kind: "practice_generate", input: parsed }
    });
  } catch (error) {
    if (sessionId) await cleanupFailedGenerationSession({ sessionId, userId: input.userId });
    throw error;
  }
}
