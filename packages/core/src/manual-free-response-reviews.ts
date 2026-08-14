import { and, desc, eq, isNull } from "drizzle-orm";
import type {
  ManualFreeResponseReviewItem,
  PracticeRubric,
  SubmitManualFreeResponseReviewInput
} from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";
import { createKnowledgePointMasterySnapshot } from "./knowledge-point-mastery";

const MAX_PENDING_REVIEWS = 100;

function freeResponseRubric(
  value: unknown
): Extract<PracticeRubric, { kind: "free_response" }> | null {
  if (!value || typeof value !== "object") return null;
  const rubric = value as Partial<PracticeRubric>;
  if (
    rubric.kind !== "free_response" ||
    !Array.isArray(rubric.criteria) ||
    !rubric.criteria.every((item) => typeof item === "string" && item.length > 0) ||
    !Number.isInteger(rubric.maximumScore) ||
    !rubric.maximumScore ||
    typeof rubric.note !== "string" ||
    !rubric.note
  )
    return null;
  return rubric as Extract<PracticeRubric, { kind: "free_response" }>;
}

export async function listManualFreeResponseReviews(
  organizationId: string
): Promise<ManualFreeResponseReviewItem[]> {
  const db = getDatabase();
  const [practiceRows, assessmentRows] = await Promise.all([
    db
      .select({ attempt: schema.practiceAttempts })
      .from(schema.practiceAttempts)
      .innerJoin(
        schema.resourceVersions,
        eq(schema.practiceAttempts.resourceVersionId, schema.resourceVersions.id)
      )
      .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
      .innerJoin(schema.knowledgeSpaces, eq(schema.resources.spaceId, schema.knowledgeSpaces.id))
      .leftJoin(
        schema.practiceGrades,
        eq(schema.practiceGrades.attemptId, schema.practiceAttempts.id)
      )
      .where(
        and(
          eq(schema.knowledgeSpaces.organizationId, organizationId),
          isNull(schema.practiceGrades.id)
        )
      )
      .orderBy(desc(schema.practiceAttempts.submittedAt))
      .limit(MAX_PENDING_REVIEWS),
    db
      .select({ attempt: schema.assessmentAttempts })
      .from(schema.assessmentAttempts)
      .innerJoin(
        schema.resourceVersions,
        eq(schema.assessmentAttempts.resourceVersionId, schema.resourceVersions.id)
      )
      .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
      .innerJoin(schema.knowledgeSpaces, eq(schema.resources.spaceId, schema.knowledgeSpaces.id))
      .leftJoin(
        schema.assessmentGrades,
        eq(schema.assessmentGrades.attemptId, schema.assessmentAttempts.id)
      )
      .where(
        and(
          eq(schema.knowledgeSpaces.organizationId, organizationId),
          isNull(schema.assessmentGrades.id)
        )
      )
      .orderBy(desc(schema.assessmentAttempts.submittedAt))
      .limit(MAX_PENDING_REVIEWS)
  ]);
  return [
    ...practiceRows.flatMap(({ attempt }) => {
      const rubric = freeResponseRubric(attempt.rubric);
      return rubric
        ? [
            {
              attemptType: "practice" as const,
              attemptId: attempt.id,
              learnerUserId: attempt.userId,
              courseUnitId: attempt.courseUnitId,
              knowledgePointId: attempt.knowledgePointId,
              resourceVersionId: attempt.resourceVersionId,
              sourceRef: attempt.sourceRef,
              questionVersion: attempt.questionVersion,
              prompt: attempt.prompt,
              rubric,
              response: attempt.response,
              submittedAt: attempt.submittedAt.toISOString()
            }
          ]
        : [];
    }),
    ...assessmentRows.flatMap(({ attempt }) => {
      const rubric = freeResponseRubric(attempt.rubric);
      return rubric
        ? [
            {
              attemptType: "assessment" as const,
              attemptId: attempt.id,
              learnerUserId: attempt.userId,
              courseUnitId: attempt.courseUnitId,
              knowledgePointId: attempt.knowledgePointId,
              resourceVersionId: attempt.resourceVersionId,
              sourceRef: attempt.sourceRef,
              questionVersion: attempt.questionVersion,
              prompt: attempt.prompt,
              rubric,
              response: attempt.response,
              submittedAt: attempt.submittedAt.toISOString()
            }
          ]
        : [];
    })
  ]
    .sort((left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt))
    .slice(0, MAX_PENDING_REVIEWS);
}

function assertManualScore(
  score: number,
  rubric: Extract<PracticeRubric, { kind: "free_response" }>
) {
  if (score > rubric.maximumScore) throw new Error("MANUAL_REVIEW_SCORE_INVALID");
}

export async function submitManualFreeResponseReview(
  input: SubmitManualFreeResponseReviewInput & {
    attemptId: string;
    organizationId: string;
    reviewerUserId: string;
  }
) {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    if (input.attemptType === "practice") {
      const [row] = await tx
        .select({
          attempt: schema.practiceAttempts,
          courseId: schema.practiceSets.courseId,
          organizationId: schema.knowledgeSpaces.organizationId,
          gradeId: schema.practiceGrades.id
        })
        .from(schema.practiceAttempts)
        .innerJoin(
          schema.practiceQuestions,
          eq(schema.practiceAttempts.practiceQuestionId, schema.practiceQuestions.id)
        )
        .innerJoin(
          schema.practiceSets,
          eq(schema.practiceQuestions.practiceSetId, schema.practiceSets.id)
        )
        .innerJoin(
          schema.resourceVersions,
          eq(schema.practiceAttempts.resourceVersionId, schema.resourceVersions.id)
        )
        .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
        .innerJoin(schema.knowledgeSpaces, eq(schema.resources.spaceId, schema.knowledgeSpaces.id))
        .leftJoin(
          schema.practiceGrades,
          eq(schema.practiceGrades.attemptId, schema.practiceAttempts.id)
        )
        .where(eq(schema.practiceAttempts.id, input.attemptId))
        .limit(1);
      if (!row || row.organizationId !== input.organizationId)
        throw new Error("MANUAL_REVIEW_ATTEMPT_NOT_FOUND");
      if (row.gradeId) throw new Error("MANUAL_REVIEW_ALREADY_GRADED");
      const rubric = freeResponseRubric(row.attempt.rubric);
      if (!rubric) throw new Error("MANUAL_REVIEW_ATTEMPT_NOT_ELIGIBLE");
      assertManualScore(input.score, rubric);
      const [grade] = await tx
        .insert(schema.practiceGrades)
        .values({
          attemptId: row.attempt.id,
          grader: "human_review",
          ruleVersion: "manual_rubric.v1",
          score: input.score,
          maximumScore: rubric.maximumScore,
          correct: input.score === rubric.maximumScore,
          reviewerUserId: input.reviewerUserId,
          rationale: input.rationale
        })
        .onConflictDoNothing({ target: schema.practiceGrades.attemptId })
        .returning();
      if (!grade) throw new Error("MANUAL_REVIEW_ALREADY_GRADED");
      await createKnowledgePointMasterySnapshot(tx, {
        userId: row.attempt.userId,
        schemaVersion: 1,
        courseId: row.courseId,
        courseUnitId: row.attempt.courseUnitId,
        knowledgePointId: row.attempt.knowledgePointId,
        attemptType: "practice",
        attemptId: row.attempt.id,
        gradeId: grade.id,
        grader: "human_review",
        ruleVersion: "manual_rubric.v1",
        score: grade.score,
        maximumScore: grade.maximumScore,
        correct: grade.correct,
        resourceVersionId: row.attempt.resourceVersionId,
        sourceRef: row.attempt.sourceRef
      });
      await tx.insert(schema.learningEvents).values({
        userId: row.attempt.userId,
        actor: "instructor",
        verb: "practice.attempt_manually_graded",
        object: "practice_grade",
        result: { score: grade.score, maximumScore: grade.maximumScore, grader: grade.grader },
        context: {
          practiceAttemptId: row.attempt.id,
          courseId: row.courseId,
          courseUnitId: row.attempt.courseUnitId,
          knowledgePointId: row.attempt.knowledgePointId,
          resourceVersionId: row.attempt.resourceVersionId,
          sourceRef: row.attempt.sourceRef
        }
      });
      await tx.insert(schema.auditEvents).values({
        organizationId: input.organizationId,
        actorUserId: input.reviewerUserId,
        action: "learning.free_response_reviewed",
        targetType: "practice_attempt",
        targetId: row.attempt.id,
        metadata: { score: grade.score, maximumScore: grade.maximumScore, gradeId: grade.id }
      });
      return { attemptType: "practice" as const, attemptId: row.attempt.id, grade };
    }

    const [row] = await tx
      .select({
        attempt: schema.assessmentAttempts,
        courseId: schema.assessments.courseId,
        organizationId: schema.knowledgeSpaces.organizationId,
        gradeId: schema.assessmentGrades.id
      })
      .from(schema.assessmentAttempts)
      .innerJoin(
        schema.assessments,
        eq(schema.assessmentAttempts.assessmentId, schema.assessments.id)
      )
      .innerJoin(
        schema.resourceVersions,
        eq(schema.assessmentAttempts.resourceVersionId, schema.resourceVersions.id)
      )
      .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
      .innerJoin(schema.knowledgeSpaces, eq(schema.resources.spaceId, schema.knowledgeSpaces.id))
      .leftJoin(
        schema.assessmentGrades,
        eq(schema.assessmentGrades.attemptId, schema.assessmentAttempts.id)
      )
      .where(eq(schema.assessmentAttempts.id, input.attemptId))
      .limit(1);
    if (!row || row.organizationId !== input.organizationId)
      throw new Error("MANUAL_REVIEW_ATTEMPT_NOT_FOUND");
    if (row.gradeId) throw new Error("MANUAL_REVIEW_ALREADY_GRADED");
    const rubric = freeResponseRubric(row.attempt.rubric);
    if (!rubric) throw new Error("MANUAL_REVIEW_ATTEMPT_NOT_ELIGIBLE");
    assertManualScore(input.score, rubric);
    const [grade] = await tx
      .insert(schema.assessmentGrades)
      .values({
        attemptId: row.attempt.id,
        grader: "human_review",
        ruleVersion: "manual_rubric.v1",
        score: input.score,
        maximumScore: rubric.maximumScore,
        correct: input.score === rubric.maximumScore,
        reviewerUserId: input.reviewerUserId,
        rationale: input.rationale
      })
      .onConflictDoNothing({ target: schema.assessmentGrades.attemptId })
      .returning();
    if (!grade) throw new Error("MANUAL_REVIEW_ALREADY_GRADED");
    await createKnowledgePointMasterySnapshot(tx, {
      userId: row.attempt.userId,
      schemaVersion: 1,
      courseId: row.courseId,
      courseUnitId: row.attempt.courseUnitId,
      knowledgePointId: row.attempt.knowledgePointId,
      attemptType: "assessment",
      attemptId: row.attempt.id,
      gradeId: grade.id,
      grader: "human_review",
      ruleVersion: "manual_rubric.v1",
      score: grade.score,
      maximumScore: grade.maximumScore,
      correct: grade.correct,
      resourceVersionId: row.attempt.resourceVersionId,
      sourceRef: row.attempt.sourceRef
    });
    await tx.insert(schema.learningEvents).values({
      userId: row.attempt.userId,
      actor: "instructor",
      verb: "assessment.attempt_manually_graded",
      object: "assessment_grade",
      result: { score: grade.score, maximumScore: grade.maximumScore, grader: grade.grader },
      context: {
        assessmentAttemptId: row.attempt.id,
        courseId: row.courseId,
        courseUnitId: row.attempt.courseUnitId,
        knowledgePointId: row.attempt.knowledgePointId,
        resourceVersionId: row.attempt.resourceVersionId,
        sourceRef: row.attempt.sourceRef
      }
    });
    await tx.insert(schema.auditEvents).values({
      organizationId: input.organizationId,
      actorUserId: input.reviewerUserId,
      action: "learning.free_response_reviewed",
      targetType: "assessment_attempt",
      targetId: row.attempt.id,
      metadata: { score: grade.score, maximumScore: grade.maximumScore, gradeId: grade.id }
    });
    return { attemptType: "assessment" as const, attemptId: row.attempt.id, grade };
  });
}
