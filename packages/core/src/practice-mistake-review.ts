import { and, desc, eq, inArray } from "drizzle-orm";
import type { PracticeMistakeReviewItem } from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";
import { getActiveLearningCourse } from "./learning-plans";

const MAX_MISTAKE_REVIEW_ITEMS = 50;

export async function listActivePracticeMistakeReviews(
  userId: string
): Promise<PracticeMistakeReviewItem[]> {
  const course = await getActiveLearningCourse(userId);
  const sets = await getDatabase()
    .select({ id: schema.practiceSets.id })
    .from(schema.practiceSets)
    .where(
      and(
        eq(schema.practiceSets.userId, userId),
        eq(schema.practiceSets.courseId, course.id),
        eq(schema.practiceSets.status, "candidate")
      )
    );
  const setIds = sets.map(({ id }) => id);
  if (!setIds.length) return [];
  const rows = await getDatabase()
    .select({ attempt: schema.practiceAttempts, grade: schema.practiceGrades })
    .from(schema.practiceAttempts)
    .innerJoin(
      schema.practiceQuestions,
      eq(schema.practiceAttempts.practiceQuestionId, schema.practiceQuestions.id)
    )
    .innerJoin(
      schema.practiceGrades,
      eq(schema.practiceGrades.attemptId, schema.practiceAttempts.id)
    )
    .where(
      and(
        eq(schema.practiceAttempts.userId, userId),
        inArray(schema.practiceQuestions.practiceSetId, setIds)
      )
    )
    .orderBy(
      desc(schema.practiceAttempts.practiceQuestionId),
      desc(schema.practiceAttempts.submittedAt),
      desc(schema.practiceAttempts.id)
    );
  const latestByQuestion = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latestByQuestion.has(row.attempt.practiceQuestionId))
      latestByQuestion.set(row.attempt.practiceQuestionId, row);
  }
  return [...latestByQuestion.values()]
    .filter(({ grade }) => !grade.correct)
    .sort((left, right) => right.attempt.submittedAt.getTime() - left.attempt.submittedAt.getTime())
    .slice(0, MAX_MISTAKE_REVIEW_ITEMS)
    .map(({ attempt, grade }) => ({
      practiceQuestionId: attempt.practiceQuestionId,
      practiceAttemptId: attempt.id,
      courseUnitId: attempt.courseUnitId,
      knowledgePointId: attempt.knowledgePointId,
      resourceVersionId: attempt.resourceVersionId,
      sourceRef: attempt.sourceRef,
      questionVersion: attempt.questionVersion,
      prompt: attempt.prompt,
      response: attempt.response,
      grade: {
        id: grade.id,
        grader: "objective_rule",
        ruleVersion: "exact_response.v1",
        score: grade.score,
        maximumScore: grade.maximumScore,
        correct: grade.correct,
        rationale: grade.rationale,
        reviewedBy: grade.reviewerUserId,
        createdAt: grade.createdAt.toISOString()
      },
      submittedAt: attempt.submittedAt.toISOString()
    }));
}
