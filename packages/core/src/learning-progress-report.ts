import { and, eq, inArray } from "drizzle-orm";
import type { LearningProgressReport } from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";
import { getActiveLearningCourse, getActiveLearningProgress } from "./learning-plans";
import { getActiveCourseMasterySummary } from "./knowledge-point-mastery";

export async function getActiveLearningProgressReport(
  userId: string
): Promise<LearningProgressReport> {
  const [course, progress] = await Promise.all([
    getActiveLearningCourse(userId),
    getActiveLearningProgress(userId)
  ]);
  const [sets, mastery] = await Promise.all([
    getDatabase()
      .select({ id: schema.practiceSets.id })
      .from(schema.practiceSets)
      .where(
        and(
          eq(schema.practiceSets.userId, userId),
          eq(schema.practiceSets.courseId, course.id),
          eq(schema.practiceSets.status, "candidate")
        )
      ),
    getActiveCourseMasterySummary({ userId, courseId: course.id })
  ]);
  const setIds = sets.map(({ id }) => id);
  const questions = setIds.length
    ? await getDatabase()
        .select({ id: schema.practiceQuestions.id })
        .from(schema.practiceQuestions)
        .where(inArray(schema.practiceQuestions.practiceSetId, setIds))
    : [];
  const questionIds = questions.map(({ id }) => id);
  const attempts = questionIds.length
    ? await getDatabase()
        .select({
          status: schema.practiceAttempts.status,
          sourceRef: schema.practiceAttempts.sourceRef,
          resourceVersionId: schema.practiceAttempts.resourceVersionId,
          grade: schema.practiceGrades
        })
        .from(schema.practiceAttempts)
        .leftJoin(
          schema.practiceGrades,
          eq(schema.practiceGrades.attemptId, schema.practiceAttempts.id)
        )
        .where(
          and(
            eq(schema.practiceAttempts.userId, userId),
            inArray(schema.practiceAttempts.practiceQuestionId, questionIds)
          )
        )
    : [];
  const completed = progress.filter(({ completedAt }) => completedAt !== null).length;
  return {
    learningPlanId: course.learningPlanId,
    courseId: course.id,
    units: {
      total: progress.length,
      completed,
      completionPercent: progress.length
        ? Math.round((completed / progress.length) * 10_000) / 100
        : 0
    },
    practice: {
      candidateSets: sets.length,
      questions: questions.length,
      attempts: attempts.length,
      pendingReview: attempts.filter(({ grade }) => grade === null).length,
      objectiveGraded: attempts.filter(({ grade }) => grade !== null).length,
      objectiveCorrect: attempts.filter(({ grade }) => grade?.correct).length,
      objectiveScore: attempts.reduce((total, { grade }) => total + (grade?.score ?? 0), 0),
      objectiveMaximumScore: attempts.reduce(
        (total, { grade }) => total + (grade?.maximumScore ?? 0),
        0
      ),
      traceableAttempts: attempts.filter(
        ({ sourceRef, resourceVersionId }) =>
          sourceRef.startsWith("wk://source/") && resourceVersionId.length > 0
      ).length
    },
    mastery
  };
}
