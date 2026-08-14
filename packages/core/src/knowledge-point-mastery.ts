import { and, desc, eq, inArray } from "drizzle-orm";
import type { LearningProgressReport } from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";

export type MasteryAttemptType = "practice" | "assessment";

export type MasteryEvidence = {
  schemaVersion: 1;
  courseId: string;
  courseUnitId: string;
  knowledgePointId: string;
  attemptType: MasteryAttemptType;
  attemptId: string;
  gradeId: string;
  grader: "objective_rule" | "human_review";
  ruleVersion: "exact_response.v1" | "manual_rubric.v1";
  score: number;
  maximumScore: number;
  correct: boolean;
  resourceVersionId: string;
  sourceRef: string;
};

type CreateMasterySnapshotInput = MasteryEvidence & { userId: string };

type DatabaseTransaction = Parameters<
  Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]
>[0];

export async function createKnowledgePointMasterySnapshot(
  tx: DatabaseTransaction,
  input: CreateMasterySnapshotInput
) {
  if (
    !input.courseId ||
    !input.courseUnitId ||
    !input.knowledgePointId ||
    !input.attemptId ||
    !input.gradeId ||
    !input.resourceVersionId ||
    !input.sourceRef.startsWith("wk://source/") ||
    input.maximumScore <= 0 ||
    input.score < 0 ||
    input.score > input.maximumScore
  )
    throw new Error("MASTERY_SNAPSHOT_EVIDENCE_INVALID");
  const { userId, ...evidence } = input;
  await tx
    .insert(schema.masterySnapshots)
    .values({
      userId: inputUserId(userId),
      gradeId: input.gradeId,
      knowledgePointId: input.knowledgePointId,
      score: input.score / input.maximumScore,
      evidence
    })
    .onConflictDoNothing({ target: schema.masterySnapshots.gradeId });
}

function inputUserId(userId: string): string {
  if (!userId) throw new Error("MASTERY_SNAPSHOT_EVIDENCE_INVALID");
  return userId;
}

export async function getActiveCourseMasterySummary(input: {
  userId: string;
  courseId: string;
}): Promise<LearningProgressReport["mastery"]> {
  const points = await getDatabase()
    .select({
      id: schema.courseKnowledgePoints.id
    })
    .from(schema.courseKnowledgePoints)
    .innerJoin(
      schema.courseUnits,
      eq(schema.courseKnowledgePoints.courseUnitId, schema.courseUnits.id)
    )
    .innerJoin(schema.courseModules, eq(schema.courseUnits.courseModuleId, schema.courseModules.id))
    .where(eq(schema.courseModules.courseId, input.courseId));
  if (!points.length)
    return {
      totalKnowledgePoints: 0,
      gradedKnowledgePoints: 0,
      currentCorrect: 0,
      averagePercent: null,
      items: []
    };
  const rows = await getDatabase()
    .select()
    .from(schema.masterySnapshots)
    .where(
      and(
        eq(schema.masterySnapshots.userId, input.userId),
        inArray(
          schema.masterySnapshots.knowledgePointId,
          points.map(({ id }) => id)
        )
      )
    )
    .orderBy(desc(schema.masterySnapshots.createdAt), desc(schema.masterySnapshots.id));
  const currentByPoint = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const evidence = row.evidence as Partial<MasteryEvidence>;
    if (evidence.courseId !== input.courseId || currentByPoint.has(row.knowledgePointId)) continue;
    currentByPoint.set(row.knowledgePointId, row);
  }
  const items = points.map((point) => {
    const snapshot = currentByPoint.get(point.id);
    if (!snapshot) {
      return {
        knowledgePointId: point.id,
        status: "ungraded" as const,
        correct: null,
        score: null,
        maximumScore: null,
        percent: null,
        updatedAt: null
      };
    }
    const evidence = snapshot.evidence as MasteryEvidence;
    return {
      knowledgePointId: point.id,
      status: "graded" as const,
      correct: evidence.correct,
      score: evidence.score,
      maximumScore: evidence.maximumScore,
      percent: Math.round((evidence.score / evidence.maximumScore) * 10_000) / 100,
      updatedAt: snapshot.createdAt.toISOString()
    };
  });
  const graded = items.filter((item) => item.status === "graded");
  return {
    totalKnowledgePoints: points.length,
    gradedKnowledgePoints: graded.length,
    currentCorrect: graded.filter((item) => item.correct).length,
    averagePercent: graded.length
      ? Math.round(
          (graded.reduce((total, item) => total + (item.percent ?? 0), 0) / graded.length) * 100
        ) / 100
      : null,
    items
  };
}
