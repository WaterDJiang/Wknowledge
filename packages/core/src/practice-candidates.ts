import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type {
  CreatePracticeCandidateInput,
  LearningPlanSnapshot,
  MaterializePracticeGenerateCandidateInput,
  PracticeAttempt,
  PracticeGenerateCandidate,
  PracticeGenerateCandidateOutput,
  PracticeGrade,
  PracticeQuestion,
  PracticeRubric,
  PracticeSet,
  SkillRunProvenance,
  SubmitPracticeAttemptInput
} from "@wknowledge/contracts";
import { practiceGenerateCandidateOutputSchema } from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";
import { parseLocatorRef } from "@wknowledge/wiki";
import { resolveAgentSessionContext } from "./agent-sessions";
import { createKnowledgePointMasterySnapshot } from "./knowledge-point-mastery";
import {
  assertLearningPlanSourcesReadable,
  assertLearningResourceVersionsReadable
} from "./learning-source-access";

const MAX_CANDIDATE_SETS = 20;

function rubricForDifficulty(
  difficulty: CreatePracticeCandidateInput["difficulty"]
): PracticeRubric {
  if (difficulty === "easy") {
    return {
      kind: "exact_response",
      normalization: "nfkc_trim_casefold_whitespace",
      maximumScore: 1,
      note: "请回到固定原文，写出该学习重点。提交后按受管答案键进行确定性判定。"
    };
  }
  const detail =
    difficulty === "challenge"
      ? "结合原文解释概念之间的关系、边界或适用条件，并给出可核对的依据。"
      : "用自己的话概括原文中的核心概念、关键要点和适用条件。";
  return {
    kind: "free_response",
    criteria: ["表述准确", "覆盖原文关键要点", "能够回到给定原文依据"],
    maximumScore: 3,
    note: `${detail} 本候选不自动评分，正式评分需要后续审核与评分规则。`
  };
}

function promptForQuestion(input: {
  title: string;
  statement: string;
  difficulty: CreatePracticeCandidateInput["difficulty"];
}) {
  const focus =
    input.difficulty === "easy"
      ? "请写出"
      : input.difficulty === "challenge"
        ? "解释并分析"
        : "概括并说明";
  return input.difficulty === "easy"
    ? `${focus}“${input.title}”对应的原文学习重点。请回到原文后作答。`
    : `${focus}“${input.title}”。请回到原文阅读后，围绕以下学习重点作答：${input.statement}`;
}

function normalizeExactResponse(value: string) {
  return value.normalize("NFKC").trim().replaceAll(/\s+/gu, " ").toLowerCase();
}

function presentGrade(input: typeof schema.practiceGrades.$inferSelect): PracticeGrade {
  return {
    id: input.id,
    grader: input.grader === "human_review" ? "human_review" : "objective_rule",
    ruleVersion:
      input.ruleVersion === "manual_rubric.v1" ? "manual_rubric.v1" : "exact_response.v1",
    score: input.score,
    maximumScore: input.maximumScore,
    correct: input.correct,
    rationale: input.rationale,
    reviewedBy: input.reviewerUserId,
    createdAt: input.createdAt.toISOString()
  };
}

async function activeCourseForUser(userId: string, sourceError = "PRACTICE_SOURCE_REVOKED") {
  const [profile] = await getDatabase()
    .select({ id: schema.learnerProfiles.id })
    .from(schema.learnerProfiles)
    .where(eq(schema.learnerProfiles.userId, userId))
    .limit(1);
  if (!profile) throw new Error("LEARNING_PLAN_ACTIVE_NOT_FOUND");
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
  const [course] = await getDatabase()
    .select()
    .from(schema.courses)
    .where(and(eq(schema.courses.learningPlanId, plan.id), eq(schema.courses.status, "active")))
    .limit(1);
  if (!course) throw new Error("LEARNING_COURSE_ACTIVE_NOT_FOUND");
  return { plan, course };
}

async function completedPlanUnitIdsForUser(userId: string, planId: string): Promise<Set<string>> {
  const events = await getDatabase()
    .select()
    .from(schema.learningEvents)
    .where(
      and(eq(schema.learningEvents.userId, userId), eq(schema.learningEvents.verb, "completed"))
    );
  return new Set(
    events.flatMap((event) => {
      const context = event.context as Record<string, unknown>;
      return context.planId === planId && typeof context.unitId === "string"
        ? [context.unitId]
        : [];
    })
  );
}

function presentAttempt(
  input: typeof schema.practiceAttempts.$inferSelect,
  grade: typeof schema.practiceGrades.$inferSelect | null = null
): PracticeAttempt {
  return {
    id: input.id,
    practiceQuestionId: input.practiceQuestionId,
    courseUnitId: input.courseUnitId,
    knowledgePointId: input.knowledgePointId,
    resourceVersionId: input.resourceVersionId,
    sourceRef: input.sourceRef,
    questionVersion: input.questionVersion,
    prompt: input.prompt,
    rubric: input.rubric as PracticeRubric,
    response: input.response,
    status: grade ? "graded" : "pending_review",
    grade: grade ? presentGrade(grade) : null,
    submittedAt: input.submittedAt.toISOString()
  };
}

async function presentQuestion(
  input: typeof schema.practiceQuestions.$inferSelect,
  userId: string
): Promise<PracticeQuestion> {
  const attempts = await getDatabase()
    .select({ attempt: schema.practiceAttempts, grade: schema.practiceGrades })
    .from(schema.practiceAttempts)
    .leftJoin(
      schema.practiceGrades,
      eq(schema.practiceGrades.attemptId, schema.practiceAttempts.id)
    )
    .where(
      and(
        eq(schema.practiceAttempts.practiceQuestionId, input.id),
        eq(schema.practiceAttempts.userId, userId)
      )
    )
    .orderBy(desc(schema.practiceAttempts.submittedAt));
  return {
    id: input.id,
    courseUnitId: input.courseUnitId,
    knowledgePointId: input.knowledgePointId,
    resourceVersionId: input.resourceVersionId,
    sourceRef: input.sourceRef,
    version: input.version,
    answerType: input.answerType === "exact_response" ? "exact_response" : "free_response",
    prompt: input.prompt,
    rubric: input.rubric as PracticeRubric,
    createdAt: input.createdAt.toISOString(),
    attempts: attempts.map(({ attempt, grade }) => presentAttempt(attempt, grade))
  };
}

async function presentPracticeSet(
  input: typeof schema.practiceSets.$inferSelect,
  userId: string
): Promise<PracticeSet> {
  const questions = await getDatabase()
    .select()
    .from(schema.practiceQuestions)
    .where(eq(schema.practiceQuestions.practiceSetId, input.id))
    .orderBy(asc(schema.practiceQuestions.createdAt));
  if (!questions.length) throw new Error("PRACTICE_SET_QUESTION_MISSING");
  await assertLearningResourceVersionsReadable({
    userId,
    resourceVersionIds: questions.map(({ resourceVersionId }) => resourceVersionId),
    errorCode: "PRACTICE_SOURCE_REVOKED"
  });
  let provenance: SkillRunProvenance | null = null;
  if (input.generation === "skill_candidate") {
    if (!input.skillRunId) throw new Error("PRACTICE_SET_PROVENANCE_MISSING");
    const [run] = await getDatabase()
      .select()
      .from(schema.skillRuns)
      .where(eq(schema.skillRuns.id, input.skillRunId))
      .limit(1);
    if (!run || run.skillId !== "practice-generate")
      throw new Error("PRACTICE_SET_PROVENANCE_MISSING");
    provenance = {
      skillRunId: run.id,
      skillId: run.skillId,
      skillVersion: run.skillVersion,
      skillDigest: run.skillDigest
    };
  }
  return {
    id: input.id,
    courseId: input.courseId,
    status: "candidate",
    difficulty: input.difficulty,
    generation:
      input.generation === "skill_candidate" ? "skill_candidate" : "deterministic_template",
    provenance,
    createdAt: input.createdAt.toISOString(),
    questions: await Promise.all(
      questions.map((question) => presentQuestion(question, input.userId))
    )
  };
}

export async function listPracticeCandidates(userId: string): Promise<PracticeSet[]> {
  const { course } = await activeCourseForUser(userId);
  const rows = await getDatabase()
    .select()
    .from(schema.practiceSets)
    .where(
      and(
        eq(schema.practiceSets.userId, userId),
        eq(schema.practiceSets.courseId, course.id),
        eq(schema.practiceSets.status, "candidate")
      )
    )
    .orderBy(desc(schema.practiceSets.createdAt))
    .limit(MAX_CANDIDATE_SETS);
  return Promise.all(rows.map((row) => presentPracticeSet(row, userId)));
}

export async function listPracticeGenerateCandidates(
  userId: string
): Promise<PracticeGenerateCandidate[]> {
  const rows = await getDatabase()
    .select({ candidate: schema.practiceGenerateCandidates, run: schema.skillRuns })
    .from(schema.practiceGenerateCandidates)
    .innerJoin(
      schema.skillRuns,
      eq(schema.practiceGenerateCandidates.skillRunId, schema.skillRuns.id)
    )
    .where(
      and(
        eq(schema.practiceGenerateCandidates.userId, userId),
        eq(schema.skillRuns.userId, userId),
        eq(schema.skillRuns.skillId, "practice-generate"),
        eq(schema.skillRuns.status, "completed")
      )
    )
    .orderBy(desc(schema.practiceGenerateCandidates.createdAt))
    .limit(MAX_CANDIDATE_SETS);
  const candidates = rows.map(({ candidate, run }) => {
    const output = practiceGenerateCandidateOutputSchema.safeParse(candidate.candidate);
    if (!output.success) throw new Error("PRACTICE_GENERATE_CANDIDATE_INVALID");
    return {
      id: candidate.id,
      skillRunId: run.id,
      courseId: output.data.courseId,
      difficulty: output.data.difficulty,
      questions: output.data.questions.map((question) => {
        if (question.answerType === "exact_response") {
          return {
            courseUnitId: question.courseUnitId,
            knowledgePointId: question.knowledgePointId,
            resourceVersionId: question.resourceVersionId,
            sourceRef: question.sourceRef,
            answerType: question.answerType,
            prompt: question.prompt,
            rubric: question.rubric
          };
        }
        return question;
      }),
      materializedPracticeSetId: candidate.materializedPracticeSetId,
      createdAt: candidate.createdAt.toISOString()
    };
  });
  await assertLearningResourceVersionsReadable({
    userId,
    resourceVersionIds: candidates.flatMap(({ questions }) =>
      questions.map(({ resourceVersionId }) => resourceVersionId)
    ),
    errorCode: "PRACTICE_GENERATE_SOURCE_REVOKED"
  });
  return candidates;
}

async function assertCandidateOutputMatchesCurrentCourse(input: {
  userId: string;
  plan: typeof schema.learningPlans.$inferSelect;
  course: typeof schema.courses.$inferSelect;
  output: PracticeGenerateCandidateOutput;
}) {
  if (input.output.courseId !== input.course.id) throw new Error("PRACTICE_GENERATE_COURSE_DENIED");
  const completedPlanUnitIds = await completedPlanUnitIdsForUser(input.userId, input.plan.id);
  const courseUnitIds = [
    ...new Set(input.output.questions.map(({ courseUnitId }) => courseUnitId))
  ];
  const rows = await getDatabase()
    .select({ unit: schema.courseUnits, point: schema.courseKnowledgePoints })
    .from(schema.courseUnits)
    .innerJoin(
      schema.courseKnowledgePoints,
      eq(schema.courseKnowledgePoints.courseUnitId, schema.courseUnits.id)
    )
    .innerJoin(schema.courseModules, eq(schema.courseUnits.courseModuleId, schema.courseModules.id))
    .where(
      and(
        eq(schema.courseModules.courseId, input.course.id),
        inArray(schema.courseUnits.id, courseUnitIds)
      )
    );
  const evidenceByKey = new Map(
    rows.map(({ unit, point }) => [`${unit.id}:${point.id}`, { unit, point }])
  );
  const questionKeys = new Set<string>();
  for (const question of input.output.questions) {
    const key = `${question.courseUnitId}:${question.knowledgePointId}`;
    if (questionKeys.has(key)) throw new Error("PRACTICE_GENERATE_QUESTION_DUPLICATE");
    questionKeys.add(key);
    const evidence = evidenceByKey.get(key);
    if (!evidence) throw new Error("PRACTICE_GENERATE_COURSE_DENIED");
    if (!completedPlanUnitIds.has(evidence.unit.planUnitId))
      throw new Error("PRACTICE_GENERATE_COURSE_UNIT_NOT_COMPLETED");
    if (
      question.resourceVersionId !== evidence.unit.resourceVersionId ||
      question.resourceVersionId !== evidence.point.resourceVersionId ||
      question.sourceRef !== evidence.unit.sourceRef ||
      question.sourceRef !== evidence.point.sourceRef
    )
      throw new Error("PRACTICE_GENERATE_SOURCE_DENIED");
    try {
      const locator = parseLocatorRef(question.sourceRef);
      if (locator.resourceVersionId !== question.resourceVersionId)
        throw new Error("PRACTICE_GENERATE_SOURCE_DENIED");
    } catch {
      throw new Error("PRACTICE_GENERATE_SOURCE_DENIED");
    }
  }
}

export async function validatePracticeGenerateCandidateOutput(input: {
  userId: string;
  output: PracticeGenerateCandidateOutput;
}) {
  const { plan, course } = await activeCourseForUser(input.userId);
  await assertCandidateOutputMatchesCurrentCourse({ ...input, plan, course });
  return { courseId: course.id };
}

export async function materializePracticeGenerateCandidate(
  input: MaterializePracticeGenerateCandidateInput & { userId: string }
): Promise<PracticeSet> {
  const db = getDatabase();
  const [candidate] = await db
    .select({ candidate: schema.practiceGenerateCandidates, run: schema.skillRuns })
    .from(schema.practiceGenerateCandidates)
    .innerJoin(
      schema.skillRuns,
      eq(schema.practiceGenerateCandidates.skillRunId, schema.skillRuns.id)
    )
    .where(
      and(
        eq(schema.practiceGenerateCandidates.id, input.candidateId),
        eq(schema.practiceGenerateCandidates.userId, input.userId),
        eq(schema.skillRuns.userId, input.userId)
      )
    )
    .limit(1);
  if (
    !candidate ||
    candidate.run.status !== "completed" ||
    candidate.run.skillId !== "practice-generate" ||
    !candidate.run.bindingIds.length
  )
    throw new Error("PRACTICE_GENERATE_SKILL_RUN_DENIED");
  if (candidate.candidate.materializedPracticeSetId)
    throw new Error("PRACTICE_GENERATE_CANDIDATE_ALREADY_MATERIALIZED");
  const output = practiceGenerateCandidateOutputSchema.safeParse(candidate.candidate.candidate);
  if (!output.success) throw new Error("PRACTICE_GENERATE_CANDIDATE_INVALID");
  const { plan, course } = await activeCourseForUser(input.userId);
  const context = await resolveAgentSessionContext(candidate.run.sessionId, input.userId);
  const bindings = context.bindings.filter(({ id }) => candidate.run.bindingIds.includes(id));
  if (bindings.length !== candidate.run.bindingIds.length)
    throw new Error("PRACTICE_GENERATE_SCOPE_REVOKED");
  if (!bindings.some((binding) => binding.scope === "course" && binding.targetId === course.id))
    throw new Error("PRACTICE_GENERATE_SCOPE_DENIED");
  const boundResourceVersionIds = new Set(
    bindings.flatMap((binding) =>
      binding.scope === "course" && binding.targetId === course.id
        ? (binding.courseResourceVersionIds ?? [])
        : []
    )
  );
  if (
    output.data.questions.some(
      ({ resourceVersionId }) => !boundResourceVersionIds.has(resourceVersionId)
    )
  )
    throw new Error("PRACTICE_GENERATE_SCOPE_DENIED");
  await assertCandidateOutputMatchesCurrentCourse({
    userId: input.userId,
    plan,
    course,
    output: output.data
  });
  const set = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.practiceSets)
      .values({
        courseId: course.id,
        userId: input.userId,
        difficulty: output.data.difficulty,
        generation: "skill_candidate",
        skillRunId: candidate.run.id
      })
      .returning();
    if (!created) throw new Error("PRACTICE_SET_CREATE_FAILED");
    await tx.insert(schema.practiceQuestions).values(
      output.data.questions.map((question) => ({
        practiceSetId: created.id,
        courseUnitId: question.courseUnitId,
        knowledgePointId: question.knowledgePointId,
        resourceVersionId: question.resourceVersionId,
        sourceRef: question.sourceRef,
        answerType: question.answerType,
        answerKey: question.answerType === "exact_response" ? question.answerKey : null,
        prompt: question.prompt,
        rubric: question.rubric
      }))
    );
    const [claimed] = await tx
      .update(schema.practiceGenerateCandidates)
      .set({ materializedPracticeSetId: created.id, updatedAt: new Date() })
      .where(
        and(
          eq(schema.practiceGenerateCandidates.id, candidate.candidate.id),
          eq(schema.practiceGenerateCandidates.userId, input.userId),
          isNull(schema.practiceGenerateCandidates.materializedPracticeSetId)
        )
      )
      .returning({ id: schema.practiceGenerateCandidates.id });
    if (!claimed) throw new Error("PRACTICE_GENERATE_CANDIDATE_ALREADY_MATERIALIZED");
    await tx.insert(schema.learningEvents).values({
      userId: input.userId,
      actor: "system",
      verb: "practice.candidate_created",
      object: "practice_set",
      result: {
        difficulty: output.data.difficulty,
        questionCount: output.data.questions.length,
        generation: "skill_candidate"
      },
      context: {
        learningPlanId: plan.id,
        courseId: course.id,
        practiceSetId: created.id,
        skillRunId: candidate.run.id
      }
    });
    return created;
  });
  return presentPracticeSet(set, input.userId);
}

export async function createPracticeCandidate(
  input: CreatePracticeCandidateInput & { userId: string }
): Promise<PracticeSet> {
  if (new Set(input.courseUnitIds).size !== input.courseUnitIds.length)
    throw new Error("PRACTICE_COURSE_UNIT_DUPLICATE");
  const { plan, course } = await activeCourseForUser(input.userId);
  const completedPlanUnitIds = await completedPlanUnitIdsForUser(input.userId, plan.id);
  const rows = await getDatabase()
    .select({ unit: schema.courseUnits, point: schema.courseKnowledgePoints })
    .from(schema.courseUnits)
    .innerJoin(
      schema.courseKnowledgePoints,
      eq(schema.courseKnowledgePoints.courseUnitId, schema.courseUnits.id)
    )
    .innerJoin(schema.courseModules, eq(schema.courseUnits.courseModuleId, schema.courseModules.id))
    .where(
      and(
        eq(schema.courseModules.courseId, course.id),
        inArray(schema.courseUnits.id, input.courseUnitIds)
      )
    )
    .orderBy(asc(schema.courseUnits.ordinal), asc(schema.courseKnowledgePoints.ordinal));
  const units = new Map<string, typeof rows>();
  for (const row of rows) {
    const current = units.get(row.unit.id) ?? [];
    current.push(row);
    units.set(row.unit.id, current);
  }
  if (units.size !== input.courseUnitIds.length) throw new Error("PRACTICE_COURSE_UNIT_DENIED");
  for (const [courseUnitId, unitRows] of units) {
    const planUnitId = unitRows[0]?.unit.planUnitId;
    if (!planUnitId || !completedPlanUnitIds.has(planUnitId))
      throw new Error("PRACTICE_COURSE_UNIT_NOT_COMPLETED");
    if (
      unitRows.some(
        ({ unit, point }) =>
          unit.resourceVersionId !== point.resourceVersionId || unit.sourceRef !== point.sourceRef
      )
    )
      throw new Error("PRACTICE_SOURCE_INTEGRITY_FAILED");
    if (!courseUnitId) throw new Error("PRACTICE_COURSE_UNIT_DENIED");
  }
  const resourceVersionIds = [...new Set(rows.map(({ unit }) => unit.resourceVersionId))];
  await assertLearningResourceVersionsReadable({
    userId: input.userId,
    resourceVersionIds,
    errorCode: "PRACTICE_SOURCE_REVOKED"
  });
  const rubric = rubricForDifficulty(input.difficulty);
  const set = await getDatabase().transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.practiceSets)
      .values({ courseId: course.id, userId: input.userId, difficulty: input.difficulty })
      .returning();
    if (!created) throw new Error("PRACTICE_SET_CREATE_FAILED");
    await tx.insert(schema.practiceQuestions).values(
      rows.map(({ unit, point }) => ({
        practiceSetId: created.id,
        courseUnitId: unit.id,
        knowledgePointId: point.id,
        resourceVersionId: point.resourceVersionId,
        sourceRef: point.sourceRef,
        prompt: promptForQuestion({
          title: point.title,
          statement: point.statement,
          difficulty: input.difficulty
        }),
        answerType: input.difficulty === "easy" ? "exact_response" : "free_response",
        answerKey: input.difficulty === "easy" ? point.statement : null,
        rubric
      }))
    );
    await tx.insert(schema.learningEvents).values({
      userId: input.userId,
      actor: "learner",
      verb: "practice.candidate_created",
      object: "practice_set",
      result: {
        difficulty: input.difficulty,
        questionCount: rows.length,
        generation: "deterministic_template"
      },
      context: { learningPlanId: plan.id, courseId: course.id, practiceSetId: created.id }
    });
    return created;
  });
  return presentPracticeSet(set, input.userId);
}

export async function submitPracticeAttempt(
  input: SubmitPracticeAttemptInput & { questionId: string; userId: string }
): Promise<PracticeAttempt> {
  const { course } = await activeCourseForUser(input.userId, "PRACTICE_ATTEMPT_SOURCE_REVOKED");
  const [question] = await getDatabase()
    .select({ question: schema.practiceQuestions, set: schema.practiceSets })
    .from(schema.practiceQuestions)
    .innerJoin(
      schema.practiceSets,
      eq(schema.practiceQuestions.practiceSetId, schema.practiceSets.id)
    )
    .where(
      and(
        eq(schema.practiceQuestions.id, input.questionId),
        eq(schema.practiceSets.userId, input.userId),
        eq(schema.practiceSets.courseId, course.id),
        eq(schema.practiceSets.status, "candidate")
      )
    )
    .limit(1);
  if (!question) throw new Error("PRACTICE_QUESTION_NOT_FOUND");
  await assertLearningResourceVersionsReadable({
    userId: input.userId,
    resourceVersionIds: [question.question.resourceVersionId],
    errorCode: "PRACTICE_ATTEMPT_SOURCE_REVOKED"
  });
  const result = await getDatabase().transaction(async (tx) => {
    const answerKey =
      question.question.answerType === "exact_response" ? question.question.answerKey : null;
    if (question.question.answerType === "exact_response" && !answerKey)
      throw new Error("PRACTICE_QUESTION_ANSWER_KEY_MISSING");
    const response = input.response.trim();
    const eventStatus = answerKey ? "graded" : "pending_review";
    const [created] = await tx
      .insert(schema.practiceAttempts)
      .values({
        userId: input.userId,
        practiceQuestionId: question.question.id,
        courseUnitId: question.question.courseUnitId,
        knowledgePointId: question.question.knowledgePointId,
        resourceVersionId: question.question.resourceVersionId,
        sourceRef: question.question.sourceRef,
        questionVersion: question.question.version,
        prompt: question.question.prompt,
        rubric: question.question.rubric,
        response,
        answerKey,
        status: "pending_review"
      })
      .returning();
    if (!created) throw new Error("PRACTICE_ATTEMPT_CREATE_FAILED");
    const [grade] = answerKey
      ? await tx
          .insert(schema.practiceGrades)
          .values({
            attemptId: created.id,
            grader: "objective_rule",
            ruleVersion: "exact_response.v1",
            score: normalizeExactResponse(response) === normalizeExactResponse(answerKey) ? 1 : 0,
            maximumScore: 1,
            correct: normalizeExactResponse(response) === normalizeExactResponse(answerKey)
          })
          .returning()
      : [null];
    if (answerKey && !grade) throw new Error("PRACTICE_GRADE_CREATE_FAILED");
    if (grade) {
      await createKnowledgePointMasterySnapshot(tx, {
        userId: input.userId,
        schemaVersion: 1,
        courseId: course.id,
        courseUnitId: created.courseUnitId,
        knowledgePointId: created.knowledgePointId,
        attemptType: "practice",
        attemptId: created.id,
        gradeId: grade.id,
        grader: "objective_rule",
        ruleVersion: "exact_response.v1",
        score: grade.score,
        maximumScore: grade.maximumScore,
        correct: grade.correct,
        resourceVersionId: created.resourceVersionId,
        sourceRef: created.sourceRef
      });
    }
    await tx.insert(schema.learningEvents).values({
      userId: input.userId,
      actor: "learner",
      verb: "practice.attempt_submitted",
      object: "practice_attempt",
      result: {
        status: eventStatus,
        questionVersion: question.question.version
      },
      context: {
        practiceAttemptId: created.id,
        practiceQuestionId: question.question.id,
        courseId: course.id,
        courseUnitId: question.question.courseUnitId,
        knowledgePointId: question.question.knowledgePointId,
        resourceVersionId: question.question.resourceVersionId,
        sourceRef: question.question.sourceRef
      }
    });
    if (grade) {
      await tx.insert(schema.learningEvents).values({
        userId: input.userId,
        actor: "system",
        verb: "practice.attempt_graded",
        object: "practice_grade",
        result: {
          grader: "objective_rule",
          ruleVersion: "exact_response.v1",
          score: grade.score,
          maximumScore: grade.maximumScore,
          correct: grade.correct
        },
        context: {
          practiceAttemptId: created.id,
          practiceQuestionId: question.question.id,
          courseId: course.id,
          courseUnitId: question.question.courseUnitId,
          knowledgePointId: question.question.knowledgePointId,
          resourceVersionId: question.question.resourceVersionId,
          sourceRef: question.question.sourceRef
        }
      });
    }
    return { attempt: created, grade };
  });
  return presentAttempt(result.attempt, result.grade);
}
