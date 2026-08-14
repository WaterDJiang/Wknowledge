import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  learnerDeclaredSchema,
  type CreateLearningPlanInput,
  type LearnerDeclared,
  type LearnerProfile,
  type LearningContentOption,
  type LearningCourse,
  type LearningEventInput,
  type LearningPlan,
  type LearningPlanSelection,
  type LearningPlanSnapshot,
  type LearningUnitProgress,
  type MaterializePlanComposeCandidateInput,
  type PlanComposeCandidate,
  planComposeCandidateOutputSchema
} from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";
import { locatorRef, parseLocatorRef } from "@wknowledge/wiki";
import { resolveAgentSessionContext } from "./agent-sessions";
import { assertLearningPlanSourcesReadable } from "./learning-source-access";

function presentPlan(input: typeof schema.learningPlans.$inferSelect): LearningPlan {
  return {
    id: input.id,
    version: input.version,
    status: input.status,
    title: input.title,
    plan: input.plan as LearningPlanSnapshot,
    confirmedAt: input.confirmedAt?.toISOString() ?? null,
    createdAt: input.createdAt.toISOString()
  };
}

async function createCourseForPlan(
  tx: Pick<ReturnType<typeof getDatabase>, "insert">,
  plan: typeof schema.learningPlans.$inferSelect
) {
  const snapshot = plan.plan as LearningPlanSnapshot;
  const [course] = await tx
    .insert(schema.courses)
    .values({ learningPlanId: plan.id, title: plan.title, goal: snapshot.goal })
    .returning();
  if (!course) throw new Error("COURSE_CREATE_FAILED");
  const [module] = await tx
    .insert(schema.courseModules)
    .values({
      courseId: course.id,
      ordinal: 1,
      title: "原文学习",
      objective: "按计划顺序学习每份固定版本资料，并保留可追溯的完成记录。"
    })
    .returning();
  if (!module) throw new Error("COURSE_MODULE_CREATE_FAILED");
  for (const [index, unit] of snapshot.units.entries()) {
    const [courseUnit] = await tx
      .insert(schema.courseUnits)
      .values({
        courseModuleId: module.id,
        planUnitId: unit.id,
        ordinal: index + 1,
        title: unit.title,
        objective: unit.objective,
        completionRule: unit.completionRule,
        resourceVersionId: unit.resourceVersionId,
        sourceRef: unit.sourceRef
      })
      .returning();
    if (!courseUnit) throw new Error("COURSE_UNIT_CREATE_FAILED");
    await tx.insert(schema.courseKnowledgePoints).values({
      courseUnitId: courseUnit.id,
      ordinal: 1,
      title: `原文学习重点：${unit.title}`,
      statement: "本重点是课程结构锚点；正式知识拆分与练习依据仍需回查该固定版本原文。",
      resourceVersionId: unit.resourceVersionId,
      sourceRef: unit.sourceRef
    });
  }
  return course;
}

async function presentCourse(course: typeof schema.courses.$inferSelect): Promise<LearningCourse> {
  const db = getDatabase();
  const [modules, units] = await Promise.all([
    db
      .select()
      .from(schema.courseModules)
      .where(eq(schema.courseModules.courseId, course.id))
      .orderBy(asc(schema.courseModules.ordinal)),
    db
      .select({ unit: schema.courseUnits, module: schema.courseModules })
      .from(schema.courseUnits)
      .innerJoin(
        schema.courseModules,
        eq(schema.courseUnits.courseModuleId, schema.courseModules.id)
      )
      .where(eq(schema.courseModules.courseId, course.id))
      .orderBy(asc(schema.courseModules.ordinal), asc(schema.courseUnits.ordinal))
  ]);
  const unitIds = units.map(({ unit }) => unit.id);
  const points = unitIds.length
    ? await db
        .select()
        .from(schema.courseKnowledgePoints)
        .where(inArray(schema.courseKnowledgePoints.courseUnitId, unitIds))
        .orderBy(asc(schema.courseKnowledgePoints.ordinal))
    : [];
  return {
    id: course.id,
    learningPlanId: course.learningPlanId,
    status: course.status,
    title: course.title,
    goal: course.goal,
    createdAt: course.createdAt.toISOString(),
    modules: modules.map((module) => ({
      id: module.id,
      ordinal: module.ordinal,
      title: module.title,
      objective: module.objective,
      units: units
        .filter(({ unit }) => unit.courseModuleId === module.id)
        .map(({ unit }) => ({
          id: unit.id,
          planUnitId: unit.planUnitId,
          ordinal: unit.ordinal,
          title: unit.title,
          objective: unit.objective,
          completionRule: unit.completionRule,
          resourceVersionId: unit.resourceVersionId,
          sourceRef: unit.sourceRef,
          knowledgePoints: points
            .filter((point) => point.courseUnitId === unit.id)
            .map((point) => ({
              id: point.id,
              ordinal: point.ordinal,
              title: point.title,
              statement: point.statement,
              resourceVersionId: point.resourceVersionId,
              sourceRef: point.sourceRef
            }))
        }))
    }))
  };
}

async function profileForUser(userId: string) {
  const db = getDatabase();
  const [profile] = await db
    .insert(schema.learnerProfiles)
    .values({ userId })
    .onConflictDoNothing()
    .returning();
  if (profile) return profile;
  const [existing] = await db
    .select()
    .from(schema.learnerProfiles)
    .where(eq(schema.learnerProfiles.userId, userId))
    .limit(1);
  if (!existing) throw new Error("LEARNER_PROFILE_CREATE_FAILED");
  return existing;
}

function presentLearnerProfile(input: typeof schema.learnerProfiles.$inferSelect): LearnerProfile {
  return {
    id: input.id,
    declared: learnerDeclaredSchema.parse(input.declared),
    observed: input.observed,
    inferred: input.inferred,
    updatedAt: input.updatedAt.toISOString()
  };
}

export async function getLearnerProfile(userId: string) {
  return presentLearnerProfile(await profileForUser(userId));
}

export async function updateLearnerDeclared(input: { userId: string; declared: LearnerDeclared }) {
  const profile = await profileForUser(input.userId);
  return getDatabase().transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.learnerProfiles)
      .set({ declared: input.declared, updatedAt: new Date() })
      .where(eq(schema.learnerProfiles.id, profile.id))
      .returning();
    if (!updated) throw new Error("LEARNER_PROFILE_NOT_FOUND");
    await tx.insert(schema.learningEvents).values({
      userId: input.userId,
      actor: "learner",
      verb: "learner_profile.declared_updated",
      object: "learner_profile",
      result: {
        currentLevel: input.declared.currentLevel,
        weeklyMinutes: input.declared.weeklyMinutes
      },
      context: { learnerProfileId: updated.id }
    });
    return presentLearnerProfile(updated);
  });
}

export async function listLearningContentOptions(userId: string): Promise<LearningContentOption[]> {
  const rows = await getDatabase()
    .select({
      spaceId: schema.knowledgeSpaces.id,
      spaceName: schema.knowledgeSpaces.name,
      resourceId: schema.resources.id,
      resourceVersionId: schema.resourceVersions.id,
      resourceName: schema.resources.name,
      originalName: schema.resourceVersions.originalName,
      version: schema.resourceVersions.version,
      mimeType: schema.resourceVersions.mimeType,
      compileProfile: schema.resourceVersions.compileProfile,
      createdAt: schema.resourceVersions.createdAt
    })
    .from(schema.spaceMemberships)
    .innerJoin(
      schema.knowledgeSpaces,
      eq(schema.spaceMemberships.spaceId, schema.knowledgeSpaces.id)
    )
    .innerJoin(
      schema.organizationMemberships,
      and(
        eq(schema.organizationMemberships.organizationId, schema.knowledgeSpaces.organizationId),
        eq(schema.organizationMemberships.userId, userId)
      )
    )
    .innerJoin(schema.resources, eq(schema.resources.spaceId, schema.knowledgeSpaces.id))
    .innerJoin(schema.resourceVersions, eq(schema.resourceVersions.resourceId, schema.resources.id))
    .where(
      and(
        eq(schema.spaceMemberships.userId, userId),
        eq(schema.organizationMemberships.disabled, false),
        eq(schema.resources.status, "ready")
      )
    )
    .orderBy(desc(schema.resourceVersions.createdAt));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export async function listLearningPlans(userId: string) {
  const profile = await profileForUser(userId);
  const rows = await getDatabase()
    .select()
    .from(schema.learningPlans)
    .where(eq(schema.learningPlans.learnerProfileId, profile.id))
    .orderBy(desc(schema.learningPlans.version));
  return rows.map(presentPlan);
}

export async function listPlanComposeCandidates(userId: string): Promise<PlanComposeCandidate[]> {
  const rows = await getDatabase()
    .select({ candidate: schema.planComposeCandidates, run: schema.skillRuns })
    .from(schema.planComposeCandidates)
    .innerJoin(schema.skillRuns, eq(schema.planComposeCandidates.skillRunId, schema.skillRuns.id))
    .where(
      and(
        eq(schema.planComposeCandidates.userId, userId),
        eq(schema.skillRuns.userId, userId),
        eq(schema.skillRuns.skillId, "plan-compose"),
        eq(schema.skillRuns.status, "completed")
      )
    )
    .orderBy(desc(schema.planComposeCandidates.createdAt))
    .limit(20);
  return rows.map(({ candidate, run }) => {
    const output = planComposeCandidateOutputSchema.safeParse(candidate.candidate);
    if (!output.success) throw new Error("PLAN_COMPOSE_CANDIDATE_INVALID");
    return {
      id: candidate.id,
      skillRunId: run.id,
      title: output.data.title,
      resourceVersionIds: [
        ...new Set(output.data.units.map(({ resourceVersionId }) => resourceVersionId))
      ],
      units: output.data.units,
      materializedLearningPlanId: candidate.materializedLearningPlanId,
      createdAt: candidate.createdAt.toISOString()
    };
  });
}

export async function createLearningPlanDraft(input: CreateLearningPlanInput & { userId: string }) {
  if (new Set(input.resourceVersionIds).size !== input.resourceVersionIds.length)
    throw new Error("LEARNING_PLAN_SELECTION_DUPLICATE");
  const profile = await profileForUser(input.userId);
  const options = await listLearningContentOptions(input.userId);
  const learnerDeclared = learnerDeclaredSchema.parse(profile.declared);
  const optionByVersion = new Map(options.map((option) => [option.resourceVersionId, option]));
  const selected = input.resourceVersionIds.map((id) => optionByVersion.get(id));
  if (selected.some((option) => !option)) throw new Error("LEARNING_PLAN_SELECTION_DENIED");
  const selections: LearningPlanSelection[] = selected.map((option) => ({
    spaceId: option!.spaceId,
    resourceId: option!.resourceId,
    resourceVersionId: option!.resourceVersionId,
    resourceName: option!.resourceName,
    originalName: option!.originalName,
    version: option!.version,
    mimeType: option!.mimeType,
    compileProfile: option!.compileProfile,
    sourceRef: locatorRef({
      type: "document",
      resourceVersionId: option!.resourceVersionId,
      nodeId: "learning-original"
    })
  }));
  const plan: LearningPlanSnapshot = {
    schemaVersion: 1,
    generation: "deterministic_template",
    goal: input.goal,
    learnerDeclared,
    selections,
    units: selections.map((selection, index) => ({
      id: `unit-${String(index + 1).padStart(2, "0")}`,
      title: `学习 ${selection.originalName}`,
      resourceVersionId: selection.resourceVersionId,
      sourceRef: selection.sourceRef,
      objective: `围绕“${input.goal}”以${learnerDeclared.preferredPace === "intensive" ? "集中" : "稳定"}节奏完成 ${selection.resourceName} 的原文学习。`,
      completionRule: "打开固定版本原文并完成学习记录后，才可进入后续练习。"
    }))
  };
  return getDatabase().transaction(async (tx) => {
    await tx
      .select({ id: schema.learnerProfiles.id })
      .from(schema.learnerProfiles)
      .where(eq(schema.learnerProfiles.id, profile.id))
      .for("update")
      .limit(1);
    const [last] = await tx
      .select({ version: schema.learningPlans.version })
      .from(schema.learningPlans)
      .where(eq(schema.learningPlans.learnerProfileId, profile.id))
      .orderBy(desc(schema.learningPlans.version))
      .limit(1)
      .for("update");
    const [draft] = await tx
      .insert(schema.learningPlans)
      .values({
        learnerProfileId: profile.id,
        version: (last?.version ?? 0) + 1,
        title: input.title,
        plan
      })
      .returning();
    if (!draft) throw new Error("LEARNING_PLAN_CREATE_FAILED");
    return presentPlan(draft);
  });
}

export async function materializePlanComposeCandidate(
  input: MaterializePlanComposeCandidateInput & { userId: string }
): Promise<LearningPlan> {
  if (new Set(input.selectedResourceVersionIds).size !== input.selectedResourceVersionIds.length)
    throw new Error("LEARNING_PLAN_SELECTION_DUPLICATE");
  const db = getDatabase();
  const [candidate] = await db
    .select({ candidate: schema.planComposeCandidates, run: schema.skillRuns })
    .from(schema.planComposeCandidates)
    .innerJoin(schema.skillRuns, eq(schema.planComposeCandidates.skillRunId, schema.skillRuns.id))
    .where(
      and(
        eq(schema.planComposeCandidates.id, input.candidateId),
        eq(schema.planComposeCandidates.userId, input.userId),
        eq(schema.skillRuns.userId, input.userId)
      )
    )
    .limit(1);
  if (
    !candidate ||
    candidate.run.status !== "completed" ||
    candidate.run.skillId !== "plan-compose" ||
    !candidate.run.bindingIds.length
  )
    throw new Error("PLAN_COMPOSE_SKILL_RUN_DENIED");
  if (candidate.candidate.materializedLearningPlanId)
    throw new Error("PLAN_COMPOSE_CANDIDATE_ALREADY_MATERIALIZED");
  const output = planComposeCandidateOutputSchema.safeParse(candidate.candidate.candidate);
  if (!output.success) throw new Error("PLAN_COMPOSE_CANDIDATE_INVALID");
  const context = await resolveAgentSessionContext(candidate.run.sessionId, input.userId);
  const bindings = context.bindings.filter(({ id }) => candidate.run.bindingIds.includes(id));
  if (bindings.length !== candidate.run.bindingIds.length)
    throw new Error("PLAN_COMPOSE_SCOPE_REVOKED");
  const options = await listLearningContentOptions(input.userId);
  const optionByVersion = new Map(options.map((option) => [option.resourceVersionId, option]));
  const selected = input.selectedResourceVersionIds.map((id) => optionByVersion.get(id));
  if (selected.some((option) => !option)) throw new Error("LEARNING_PLAN_SELECTION_DENIED");
  const selectedVersionIds = new Set(input.selectedResourceVersionIds);
  const coversSelectedVersion = (option: LearningContentOption) =>
    bindings.some(
      (binding) =>
        binding.spaceId === option.spaceId &&
        (binding.scope === "space" ||
          (binding.scope === "resource_version" && binding.targetId === option.resourceVersionId) ||
          (binding.scope === "course" &&
            binding.courseResourceVersionIds?.includes(option.resourceVersionId)))
    );
  if (selected.some((option) => !option || !coversSelectedVersion(option)))
    throw new Error("PLAN_COMPOSE_SCOPE_DENIED");
  const coveredVersionIds = new Set<string>();
  for (const unit of output.data.units) {
    if (!selectedVersionIds.has(unit.resourceVersionId))
      throw new Error("PLAN_COMPOSE_UNIT_SELECTION_DENIED");
    let locator;
    try {
      locator = parseLocatorRef(unit.sourceRef);
    } catch {
      throw new Error("PLAN_COMPOSE_UNIT_SOURCE_DENIED");
    }
    if (locator.resourceVersionId !== unit.resourceVersionId)
      throw new Error("PLAN_COMPOSE_UNIT_SOURCE_DENIED");
    coveredVersionIds.add(unit.resourceVersionId);
  }
  if (coveredVersionIds.size !== selectedVersionIds.size)
    throw new Error("PLAN_COMPOSE_UNIT_SELECTION_INCOMPLETE");
  const profile = await profileForUser(input.userId);
  const learnerDeclared = learnerDeclaredSchema.parse(profile.declared);
  const selections: LearningPlanSelection[] = selected.map((option) => ({
    spaceId: option!.spaceId,
    resourceId: option!.resourceId,
    resourceVersionId: option!.resourceVersionId,
    resourceName: option!.resourceName,
    originalName: option!.originalName,
    version: option!.version,
    mimeType: option!.mimeType,
    compileProfile: option!.compileProfile,
    sourceRef: locatorRef({
      type: "document",
      resourceVersionId: option!.resourceVersionId,
      nodeId: "learning-original"
    })
  }));
  const plan: LearningPlanSnapshot = {
    schemaVersion: 1,
    generation: "skill_candidate",
    provenance: {
      skillRunId: candidate.run.id,
      skillId: "plan-compose",
      skillVersion: candidate.run.skillVersion,
      skillDigest: candidate.run.skillDigest
    },
    goal: input.goal,
    learnerDeclared,
    selections,
    units: output.data.units.map((unit, index) => ({
      id: `skill-unit-${String(index + 1).padStart(2, "0")}`,
      title: unit.title,
      resourceVersionId: unit.resourceVersionId,
      sourceRef: unit.sourceRef,
      objective: unit.objective,
      completionRule: unit.completionRule
    }))
  };
  return db.transaction(async (tx) => {
    await tx
      .select({ id: schema.learnerProfiles.id })
      .from(schema.learnerProfiles)
      .where(eq(schema.learnerProfiles.id, profile.id))
      .for("update")
      .limit(1);
    const [last] = await tx
      .select({ version: schema.learningPlans.version })
      .from(schema.learningPlans)
      .where(eq(schema.learningPlans.learnerProfileId, profile.id))
      .orderBy(desc(schema.learningPlans.version))
      .limit(1)
      .for("update");
    const [draft] = await tx
      .insert(schema.learningPlans)
      .values({
        learnerProfileId: profile.id,
        version: (last?.version ?? 0) + 1,
        title: output.data.title,
        plan
      })
      .returning();
    if (!draft) throw new Error("LEARNING_PLAN_CREATE_FAILED");
    const [claimed] = await tx
      .update(schema.planComposeCandidates)
      .set({ materializedLearningPlanId: draft.id, updatedAt: new Date() })
      .where(
        and(
          eq(schema.planComposeCandidates.id, candidate.candidate.id),
          eq(schema.planComposeCandidates.userId, input.userId),
          isNull(schema.planComposeCandidates.materializedLearningPlanId)
        )
      )
      .returning({ id: schema.planComposeCandidates.id });
    if (!claimed) throw new Error("PLAN_COMPOSE_CANDIDATE_ALREADY_MATERIALIZED");
    return presentPlan(draft);
  });
}

async function activePlanForUser(userId: string, sourceError = "LEARNING_PLAN_SOURCE_REVOKED") {
  const profile = await profileForUser(userId);
  const [plan] = await getDatabase()
    .select()
    .from(schema.learningPlans)
    .where(
      and(
        eq(schema.learningPlans.learnerProfileId, profile.id),
        eq(schema.learningPlans.status, "active")
      )
    )
    .orderBy(desc(schema.learningPlans.version))
    .limit(1);
  if (!plan) throw new Error("LEARNING_PLAN_ACTIVE_NOT_FOUND");
  await assertLearningPlanSourcesReadable(userId, plan.plan as LearningPlanSnapshot, sourceError);
  return plan;
}

export async function getActiveLearningPlan(userId: string) {
  return presentPlan(await activePlanForUser(userId));
}

export async function getActiveLearningCourse(userId: string) {
  const plan = await activePlanForUser(userId);
  const [course] = await getDatabase()
    .select()
    .from(schema.courses)
    .where(and(eq(schema.courses.learningPlanId, plan.id), eq(schema.courses.status, "active")))
    .limit(1);
  if (!course) throw new Error("LEARNING_COURSE_ACTIVE_NOT_FOUND");
  return presentCourse(course);
}

function eventData(event: typeof schema.learningEvents.$inferSelect) {
  const context = event.context as Record<string, unknown>;
  const result = event.result as Record<string, unknown>;
  return {
    planId: typeof context.planId === "string" ? context.planId : null,
    unitId: typeof context.unitId === "string" ? context.unitId : null,
    position:
      result.position && typeof result.position === "object"
        ? (result.position as LearningEventInput["position"])
        : null
  };
}

export async function getActiveLearningProgress(userId: string): Promise<LearningUnitProgress[]> {
  const active = await activePlanForUser(userId);
  const plan = active.plan as LearningPlanSnapshot;
  const rows = await getDatabase()
    .select()
    .from(schema.learningEvents)
    .where(eq(schema.learningEvents.userId, userId))
    .orderBy(asc(schema.learningEvents.createdAt));
  return plan.units.map((unit) => {
    const events = rows.filter((event) => {
      const data = eventData(event);
      return data.planId === active.id && data.unitId === unit.id;
    });
    const opened = events.find(({ verb }) => verb === "opened");
    const completed = [...events].reverse().find(({ verb }) => verb === "completed");
    const positioned = [...events].reverse().find((event) => eventData(event).position !== null);
    return {
      ...unit,
      events: events.length,
      openedAt: opened?.createdAt.toISOString() ?? null,
      completedAt: completed?.createdAt.toISOString() ?? null,
      lastPosition: positioned ? eventData(positioned).position : null
    };
  });
}

export async function recordActiveLearningEvent(input: LearningEventInput & { userId: string }) {
  const active = await activePlanForUser(input.userId, "LEARNING_UNIT_SOURCE_REVOKED");
  const plan = active.plan as LearningPlanSnapshot;
  const unit = plan.units.find(({ id }) => id === input.unitId);
  if (!unit || unit.sourceRef !== input.sourceRef) throw new Error("LEARNING_UNIT_SOURCE_DENIED");
  let locator;
  try {
    locator = parseLocatorRef(input.sourceRef);
  } catch {
    throw new Error("LEARNING_UNIT_SOURCE_DENIED");
  }
  if (locator.resourceVersionId !== unit.resourceVersionId)
    throw new Error("LEARNING_UNIT_SOURCE_DENIED");
  await assertLearningPlanSourcesReadable(
    input.userId,
    { ...plan, selections: [], units: [unit] },
    "LEARNING_UNIT_SOURCE_REVOKED"
  );
  await getDatabase()
    .insert(schema.learningEvents)
    .values({
      userId: input.userId,
      actor: "learner",
      verb: input.verb,
      object: "learning_plan_unit",
      result: { sourceRef: input.sourceRef, position: input.position ?? null },
      context: { planId: active.id, unitId: unit.id, resourceVersionId: unit.resourceVersionId }
    });
  return getActiveLearningProgress(input.userId);
}

export async function confirmLearningPlan(input: { planId: string; userId: string }) {
  const profile = await profileForUser(input.userId);
  return getDatabase().transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(schema.learningPlans)
      .where(
        and(
          eq(schema.learningPlans.id, input.planId),
          eq(schema.learningPlans.learnerProfileId, profile.id)
        )
      )
      .for("update")
      .limit(1);
    if (!draft) throw new Error("LEARNING_PLAN_NOT_FOUND");
    if (draft.status === "active") return presentPlan(draft);
    if (draft.status !== "draft") throw new Error("LEARNING_PLAN_NOT_DRAFT");
    const plan = draft.plan as LearningPlanSnapshot;
    const versionIds = plan.selections.map(({ resourceVersionId }) => resourceVersionId);
    const authorized = versionIds.length
      ? await tx
          .select({ id: schema.resourceVersions.id })
          .from(schema.resourceVersions)
          .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
          .innerJoin(
            schema.spaceMemberships,
            eq(schema.resources.spaceId, schema.spaceMemberships.spaceId)
          )
          .innerJoin(
            schema.knowledgeSpaces,
            eq(schema.resources.spaceId, schema.knowledgeSpaces.id)
          )
          .innerJoin(
            schema.organizationMemberships,
            and(
              eq(
                schema.organizationMemberships.organizationId,
                schema.knowledgeSpaces.organizationId
              ),
              eq(schema.organizationMemberships.userId, input.userId)
            )
          )
          .where(
            and(
              eq(schema.spaceMemberships.userId, input.userId),
              eq(schema.organizationMemberships.disabled, false),
              eq(schema.resources.status, "ready"),
              inArray(schema.resourceVersions.id, versionIds)
            )
          )
      : [];
    if (authorized.length !== versionIds.length) throw new Error("LEARNING_PLAN_SELECTION_REVOKED");
    const activePlans = await tx
      .select({ id: schema.learningPlans.id })
      .from(schema.learningPlans)
      .where(
        and(
          eq(schema.learningPlans.learnerProfileId, profile.id),
          eq(schema.learningPlans.status, "active")
        )
      )
      .for("update");
    const activePlanIds = activePlans.map(({ id }) => id);
    if (activePlanIds.length)
      await tx
        .update(schema.courses)
        .set({ status: "archived" })
        .where(inArray(schema.courses.learningPlanId, activePlanIds));
    await tx
      .update(schema.learningPlans)
      .set({ status: "archived" })
      .where(
        and(
          eq(schema.learningPlans.learnerProfileId, profile.id),
          eq(schema.learningPlans.status, "active")
        )
      );
    const [active] = await tx
      .update(schema.learningPlans)
      .set({ status: "active", confirmedAt: new Date() })
      .where(eq(schema.learningPlans.id, draft.id))
      .returning();
    if (!active) throw new Error("LEARNING_PLAN_NOT_FOUND");
    await createCourseForPlan(tx, active);
    return presentPlan(active);
  });
}
