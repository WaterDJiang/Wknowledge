import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type {
  Assessment,
  AssessmentAttempt,
  AssessmentGrade,
  LearningPlanSnapshot,
  PracticeRubric,
  SubmitAssessmentAttemptInput
} from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";
import { createKnowledgePointMasterySnapshot } from "./knowledge-point-mastery";
import {
  listPracticeGenerateCandidates,
  materializePracticeGenerateCandidate
} from "./practice-candidates";
import {
  assertLearningPlanSourcesReadable,
  assertLearningResourceVersionsReadable
} from "./learning-source-access";

function normalizeExactResponse(value: string) {
  return value.normalize("NFKC").trim().replaceAll(/\s+/gu, " ").toLowerCase();
}

function presentGrade(input: typeof schema.assessmentGrades.$inferSelect): AssessmentGrade {
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

function presentAttempt(
  input: typeof schema.assessmentAttempts.$inferSelect,
  grade: typeof schema.assessmentGrades.$inferSelect | null
): AssessmentAttempt {
  return {
    id: input.id,
    assessmentQuestionId: input.assessmentQuestionId,
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

async function activeCourseForUser(userId: string, sourceError = "ASSESSMENT_SOURCE_REVOKED") {
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

async function assertResourceVersionsAuthorized(userId: string, resourceVersionIds: string[]) {
  await assertLearningResourceVersionsReadable({
    userId,
    resourceVersionIds,
    errorCode: "ASSESSMENT_SOURCE_REVOKED"
  });
}

async function presentAssessment(
  input: typeof schema.assessments.$inferSelect,
  userId: string
): Promise<Assessment> {
  const db = getDatabase();
  const questions = await db
    .select()
    .from(schema.assessmentQuestions)
    .where(eq(schema.assessmentQuestions.assessmentId, input.id))
    .orderBy(asc(schema.assessmentQuestions.ordinal));
  if (!questions.length) throw new Error("ASSESSMENT_QUESTION_MISSING");
  await assertLearningResourceVersionsReadable({
    userId,
    resourceVersionIds: questions.map(({ resourceVersionId }) => resourceVersionId),
    errorCode: "ASSESSMENT_SOURCE_REVOKED"
  });
  const questionIds = questions.map(({ id }) => id);
  const attempts = await db
    .select({ attempt: schema.assessmentAttempts, grade: schema.assessmentGrades })
    .from(schema.assessmentAttempts)
    .leftJoin(
      schema.assessmentGrades,
      eq(schema.assessmentGrades.attemptId, schema.assessmentAttempts.id)
    )
    .where(
      and(
        eq(schema.assessmentAttempts.assessmentId, input.id),
        inArray(schema.assessmentAttempts.assessmentQuestionId, questionIds)
      )
    );
  const attemptsByQuestion = new Map(
    attempts.map(({ attempt, grade }) => [
      attempt.assessmentQuestionId,
      presentAttempt(attempt, grade)
    ])
  );
  return {
    id: input.id,
    courseId: input.courseId,
    practiceSetId: input.practiceSetId,
    status: input.status,
    title: input.title,
    startedAt: input.startedAt?.toISOString() ?? null,
    submittedAt: input.submittedAt?.toISOString() ?? null,
    createdAt: input.createdAt.toISOString(),
    questions: questions.map((question) => ({
      id: question.id,
      ordinal: question.ordinal,
      courseUnitId: question.courseUnitId,
      knowledgePointId: question.knowledgePointId,
      resourceVersionId: question.resourceVersionId,
      sourceRef: question.sourceRef,
      questionVersion: question.questionVersion,
      answerType: question.answerType === "exact_response" ? "exact_response" : "free_response",
      prompt: question.prompt,
      rubric: question.rubric as PracticeRubric,
      attempts: attemptsByQuestion.has(question.id) ? [attemptsByQuestion.get(question.id)!] : []
    }))
  };
}

export async function listAssessments(userId: string): Promise<Assessment[]> {
  const { course } = await activeCourseForUser(userId);
  const rows = await getDatabase()
    .select()
    .from(schema.assessments)
    .where(and(eq(schema.assessments.userId, userId), eq(schema.assessments.courseId, course.id)))
    .orderBy(desc(schema.assessments.createdAt));
  return Promise.all(rows.map((row) => presentAssessment(row, userId)));
}

export async function createAssessment(input: { userId: string; practiceSetId: string }) {
  const { plan, course } = await activeCourseForUser(input.userId);
  const [set] = await getDatabase()
    .select()
    .from(schema.practiceSets)
    .where(
      and(
        eq(schema.practiceSets.id, input.practiceSetId),
        eq(schema.practiceSets.userId, input.userId),
        eq(schema.practiceSets.courseId, course.id),
        eq(schema.practiceSets.status, "candidate")
      )
    )
    .limit(1);
  if (!set) throw new Error("ASSESSMENT_PRACTICE_SET_DENIED");
  const questions = await getDatabase()
    .select()
    .from(schema.practiceQuestions)
    .where(eq(schema.practiceQuestions.practiceSetId, set.id))
    .orderBy(asc(schema.practiceQuestions.createdAt));
  if (!questions.length) throw new Error("ASSESSMENT_QUESTION_MISSING");
  if (
    questions.some(
      (question) =>
        !question.courseUnitId ||
        !question.knowledgePointId ||
        !question.resourceVersionId ||
        !question.sourceRef.startsWith("wk://source/") ||
        !question.prompt.trim() ||
        !question.rubric
    )
  ) {
    throw new Error("ASSESSMENT_SOURCE_INTEGRITY_FAILED");
  }
  await assertResourceVersionsAuthorized(input.userId, [
    ...new Set(questions.map(({ resourceVersionId }) => resourceVersionId))
  ]);
  const assessment = await getDatabase().transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.assessments)
      .where(eq(schema.assessments.practiceSetId, set.id))
      .limit(1);
    if (existing) return existing;
    const [created] = await tx
      .insert(schema.assessments)
      .values({
        courseId: course.id,
        practiceSetId: set.id,
        userId: input.userId,
        title: `${set.difficulty === "easy" ? "基础" : set.difficulty === "challenge" ? "进阶" : "标准"}测评`
      })
      .returning();
    if (!created) throw new Error("ASSESSMENT_CREATE_FAILED");
    await tx.insert(schema.assessmentQuestions).values(
      questions.map((question, index) => ({
        assessmentId: created.id,
        sourcePracticeQuestionId: question.id,
        ordinal: index + 1,
        courseUnitId: question.courseUnitId,
        knowledgePointId: question.knowledgePointId,
        resourceVersionId: question.resourceVersionId,
        sourceRef: question.sourceRef,
        questionVersion: question.version,
        answerType: question.answerType,
        answerKey: question.answerKey,
        prompt: question.prompt,
        rubric: question.rubric
      }))
    );
    await tx.insert(schema.learningEvents).values({
      userId: input.userId,
      actor: "learner",
      verb: "assessment.created",
      object: "assessment",
      result: { questionCount: questions.length, source: "practice_candidate" },
      context: {
        assessmentId: created.id,
        practiceSetId: set.id,
        courseId: course.id,
        learningPlanId: plan.id
      }
    });
    return created;
  });
  return presentAssessment(assessment, input.userId);
}

export async function createAssessmentFromPracticeGenerateCandidate(input: {
  userId: string;
  candidateId: string;
}) {
  const candidate = (await listPracticeGenerateCandidates(input.userId)).find(
    ({ id }) => id === input.candidateId
  );
  if (!candidate) throw new Error("ASSESSMENT_SKILL_CANDIDATE_DENIED");
  let practiceSetId: string | null = candidate.materializedPracticeSetId ?? null;
  if (!practiceSetId) {
    try {
      practiceSetId = (await materializePracticeGenerateCandidate(input)).id;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "PRACTICE_GENERATE_CANDIDATE_ALREADY_MATERIALIZED"
      )
        throw error;
      practiceSetId =
        (await listPracticeGenerateCandidates(input.userId)).find(
          ({ id }) => id === input.candidateId
        )?.materializedPracticeSetId ?? null;
    }
  }
  if (!practiceSetId) throw new Error("ASSESSMENT_SKILL_CANDIDATE_DENIED");
  return createAssessment({ userId: input.userId, practiceSetId });
}

async function ownedAssessment(input: { assessmentId: string; userId: string }) {
  const { course } = await activeCourseForUser(input.userId);
  const [assessment] = await getDatabase()
    .select()
    .from(schema.assessments)
    .where(
      and(
        eq(schema.assessments.id, input.assessmentId),
        eq(schema.assessments.userId, input.userId),
        eq(schema.assessments.courseId, course.id)
      )
    )
    .limit(1);
  if (!assessment) throw new Error("ASSESSMENT_NOT_FOUND");
  return { assessment, course };
}

export async function startAssessment(input: { assessmentId: string; userId: string }) {
  const { assessment } = await ownedAssessment(input);
  if (assessment.status === "submitted") throw new Error("ASSESSMENT_ALREADY_SUBMITTED");
  const resourceVersions = await getDatabase()
    .select({ resourceVersionId: schema.assessmentQuestions.resourceVersionId })
    .from(schema.assessmentQuestions)
    .where(eq(schema.assessmentQuestions.assessmentId, assessment.id));
  await assertResourceVersionsAuthorized(input.userId, [
    ...new Set(resourceVersions.map(({ resourceVersionId }) => resourceVersionId))
  ]);
  const now = new Date();
  const [started] = await getDatabase()
    .update(schema.assessments)
    .set({ status: "active", startedAt: assessment.startedAt ?? now })
    .where(and(eq(schema.assessments.id, assessment.id), eq(schema.assessments.status, "draft")))
    .returning();
  const result = started ?? assessment;
  if (started) {
    await getDatabase()
      .insert(schema.learningEvents)
      .values({
        userId: input.userId,
        actor: "learner",
        verb: "assessment.started",
        object: "assessment",
        result: {},
        context: { assessmentId: assessment.id, courseId: assessment.courseId }
      });
  }
  return presentAssessment(result, input.userId);
}

export async function submitAssessmentAttempt(
  input: SubmitAssessmentAttemptInput & { assessmentId: string; userId: string }
) {
  const { assessment, course } = await ownedAssessment(input);
  if (assessment.status !== "active") throw new Error("ASSESSMENT_NOT_ACTIVE");
  const [question] = await getDatabase()
    .select()
    .from(schema.assessmentQuestions)
    .where(
      and(
        eq(schema.assessmentQuestions.id, input.assessmentQuestionId),
        eq(schema.assessmentQuestions.assessmentId, assessment.id)
      )
    )
    .limit(1);
  if (!question) throw new Error("ASSESSMENT_QUESTION_NOT_FOUND");
  await assertResourceVersionsAuthorized(input.userId, [question.resourceVersionId]);
  const response = input.response.trim();
  const result = await getDatabase().transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: schema.assessmentAttempts.id })
      .from(schema.assessmentAttempts)
      .where(eq(schema.assessmentAttempts.assessmentQuestionId, question.id))
      .limit(1);
    if (existing) throw new Error("ASSESSMENT_QUESTION_ALREADY_ANSWERED");
    const answerKey = question.answerType === "exact_response" ? question.answerKey : null;
    if (question.answerType === "exact_response" && !answerKey)
      throw new Error("ASSESSMENT_QUESTION_ANSWER_KEY_MISSING");
    const [attempt] = await tx
      .insert(schema.assessmentAttempts)
      .values({
        assessmentId: assessment.id,
        assessmentQuestionId: question.id,
        userId: input.userId,
        courseUnitId: question.courseUnitId,
        knowledgePointId: question.knowledgePointId,
        resourceVersionId: question.resourceVersionId,
        sourceRef: question.sourceRef,
        questionVersion: question.questionVersion,
        prompt: question.prompt,
        rubric: question.rubric,
        response,
        answerKey,
        status: "pending_review"
      })
      .returning();
    if (!attempt) throw new Error("ASSESSMENT_ATTEMPT_CREATE_FAILED");
    const [grade] = answerKey
      ? await tx
          .insert(schema.assessmentGrades)
          .values({
            attemptId: attempt.id,
            grader: "objective_rule",
            ruleVersion: "exact_response.v1",
            score: normalizeExactResponse(response) === normalizeExactResponse(answerKey) ? 1 : 0,
            maximumScore: 1,
            correct: normalizeExactResponse(response) === normalizeExactResponse(answerKey)
          })
          .returning()
      : [null];
    if (grade) {
      await createKnowledgePointMasterySnapshot(tx, {
        userId: input.userId,
        schemaVersion: 1,
        courseId: course.id,
        courseUnitId: attempt.courseUnitId,
        knowledgePointId: attempt.knowledgePointId,
        attemptType: "assessment",
        attemptId: attempt.id,
        gradeId: grade.id,
        grader: "objective_rule",
        ruleVersion: "exact_response.v1",
        score: grade.score,
        maximumScore: grade.maximumScore,
        correct: grade.correct,
        resourceVersionId: attempt.resourceVersionId,
        sourceRef: attempt.sourceRef
      });
    }
    await tx.insert(schema.learningEvents).values({
      userId: input.userId,
      actor: "learner",
      verb: "assessment.attempt_submitted",
      object: "assessment_attempt",
      result: {
        status: grade ? "graded" : "pending_review",
        questionVersion: question.questionVersion
      },
      context: {
        assessmentId: assessment.id,
        assessmentQuestionId: question.id,
        courseId: course.id,
        courseUnitId: question.courseUnitId,
        knowledgePointId: question.knowledgePointId,
        resourceVersionId: question.resourceVersionId,
        sourceRef: question.sourceRef
      }
    });
    if (grade) {
      await tx.insert(schema.learningEvents).values({
        userId: input.userId,
        actor: "system",
        verb: "assessment.attempt_graded",
        object: "assessment_grade",
        result: {
          grader: "objective_rule",
          ruleVersion: "exact_response.v1",
          score: grade.score,
          maximumScore: grade.maximumScore,
          correct: grade.correct
        },
        context: {
          assessmentId: assessment.id,
          assessmentQuestionId: question.id,
          courseId: course.id,
          courseUnitId: question.courseUnitId,
          knowledgePointId: question.knowledgePointId,
          resourceVersionId: question.resourceVersionId,
          sourceRef: question.sourceRef
        }
      });
    }
    return { attempt, grade };
  });
  return presentAttempt(result.attempt, result.grade);
}

export async function submitAssessment(input: { assessmentId: string; userId: string }) {
  const { assessment } = await ownedAssessment(input);
  if (assessment.status !== "active") throw new Error("ASSESSMENT_NOT_ACTIVE");
  const [questionCount, attemptCount] = await Promise.all([
    getDatabase()
      .select({ id: schema.assessmentQuestions.id })
      .from(schema.assessmentQuestions)
      .where(eq(schema.assessmentQuestions.assessmentId, assessment.id)),
    getDatabase()
      .select({ id: schema.assessmentAttempts.id })
      .from(schema.assessmentAttempts)
      .where(eq(schema.assessmentAttempts.assessmentId, assessment.id))
  ]);
  if (questionCount.length !== attemptCount.length)
    throw new Error("ASSESSMENT_ATTEMPTS_INCOMPLETE");
  const [submitted] = await getDatabase()
    .update(schema.assessments)
    .set({ status: "submitted", submittedAt: new Date() })
    .where(and(eq(schema.assessments.id, assessment.id), eq(schema.assessments.status, "active")))
    .returning();
  if (!submitted) throw new Error("ASSESSMENT_SUBMIT_CONFLICT");
  await getDatabase()
    .insert(schema.learningEvents)
    .values({
      userId: input.userId,
      actor: "learner",
      verb: "assessment.submitted",
      object: "assessment",
      result: { questionCount: questionCount.length },
      context: { assessmentId: assessment.id, courseId: assessment.courseId }
    });
  return presentAssessment(submitted, input.userId);
}
