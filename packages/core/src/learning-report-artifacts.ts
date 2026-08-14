import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import {
  learningProgressReportSchema,
  type LearningProgressReport,
  type LearningPlanSnapshot,
  type LearningReportSnapshot
} from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";
import { getActiveLearningProgressReport } from "./learning-progress-report";
import { assertLearningPlanSourcesReadable } from "./learning-source-access";

const LEARNING_REPORT_LEASE_MS = 10 * 60_000;

function presentSnapshot(
  snapshot: typeof schema.learningReportSnapshots.$inferSelect,
  artifacts: Array<typeof schema.learningReportArtifacts.$inferSelect>
): LearningReportSnapshot {
  return {
    id: snapshot.id,
    learningPlanId: snapshot.learningPlanId,
    courseId: snapshot.courseId,
    report: learningProgressReportSchema.parse(snapshot.report),
    status: snapshot.status,
    errorCode: snapshot.errorCode,
    errorMessage: snapshot.errorMessage,
    createdAt: snapshot.createdAt.toISOString(),
    completedAt: snapshot.completedAt?.toISOString() ?? null,
    artifacts: artifacts.map((artifact) => ({
      format: artifact.format,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      createdAt: artifact.createdAt.toISOString()
    }))
  };
}

async function snapshotWithArtifacts(
  snapshot: typeof schema.learningReportSnapshots.$inferSelect,
  userId: string
): Promise<LearningReportSnapshot> {
  const [plan] = await getDatabase()
    .select({ plan: schema.learningPlans.plan })
    .from(schema.learningPlans)
    .where(eq(schema.learningPlans.id, snapshot.learningPlanId))
    .limit(1);
  if (!plan) throw new Error("LEARNING_REPORT_SNAPSHOT_NOT_FOUND");
  await assertLearningPlanSourcesReadable(
    userId,
    plan.plan as LearningPlanSnapshot,
    "LEARNING_REPORT_SOURCE_REVOKED"
  );
  const artifacts = await getDatabase()
    .select()
    .from(schema.learningReportArtifacts)
    .where(eq(schema.learningReportArtifacts.snapshotId, snapshot.id));
  return presentSnapshot(snapshot, artifacts);
}

export async function createActiveLearningReportSnapshot(userId: string) {
  const report = learningProgressReportSchema.parse(await getActiveLearningProgressReport(userId));
  return getDatabase().transaction(async (tx) => {
    const [profile] = await tx
      .select({ id: schema.learnerProfiles.id })
      .from(schema.learnerProfiles)
      .where(eq(schema.learnerProfiles.userId, userId))
      .for("update")
      .limit(1);
    if (!profile) throw new Error("LEARNER_PROFILE_NOT_FOUND");
    const [plan] = await tx
      .select({ id: schema.learningPlans.id })
      .from(schema.learningPlans)
      .where(
        and(
          eq(schema.learningPlans.id, report.learningPlanId),
          eq(schema.learningPlans.learnerProfileId, profile.id),
          eq(schema.learningPlans.status, "active")
        )
      )
      .limit(1);
    if (!plan) throw new Error("LEARNING_PLAN_ACTIVE_NOT_FOUND");
    const [course] = await tx
      .select({ id: schema.courses.id })
      .from(schema.courses)
      .where(
        and(
          eq(schema.courses.id, report.courseId),
          eq(schema.courses.learningPlanId, plan.id),
          eq(schema.courses.status, "active")
        )
      )
      .limit(1);
    if (!course) throw new Error("LEARNING_COURSE_ACTIVE_NOT_FOUND");
    const [inFlight] = await tx
      .select()
      .from(schema.learningReportSnapshots)
      .where(
        and(
          eq(schema.learningReportSnapshots.userId, userId),
          eq(schema.learningReportSnapshots.courseId, course.id),
          or(
            eq(schema.learningReportSnapshots.status, "queued"),
            eq(schema.learningReportSnapshots.status, "rendering")
          )
        )
      )
      .orderBy(schema.learningReportSnapshots.createdAt)
      .limit(1);
    if (inFlight) return presentSnapshot(inFlight, []);
    const [snapshot] = await tx
      .insert(schema.learningReportSnapshots)
      .values({
        userId,
        learningPlanId: plan.id,
        courseId: course.id,
        report
      })
      .returning();
    if (!snapshot) throw new Error("LEARNING_REPORT_SNAPSHOT_CREATE_FAILED");
    await tx.insert(schema.learningReportOutbox).values({ snapshotId: snapshot.id });
    return presentSnapshot(snapshot, []);
  });
}

export async function getLearningReportSnapshot(input: { snapshotId: string; userId: string }) {
  const [snapshot] = await getDatabase()
    .select()
    .from(schema.learningReportSnapshots)
    .where(
      and(
        eq(schema.learningReportSnapshots.id, input.snapshotId),
        eq(schema.learningReportSnapshots.userId, input.userId)
      )
    )
    .limit(1);
  if (!snapshot) throw new Error("LEARNING_REPORT_SNAPSHOT_NOT_FOUND");
  return snapshotWithArtifacts(snapshot, input.userId);
}

export async function listLearningReportSnapshots(input: { userId: string; limit?: number }) {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 20);
  const snapshots = await getDatabase()
    .select()
    .from(schema.learningReportSnapshots)
    .where(eq(schema.learningReportSnapshots.userId, input.userId))
    .orderBy(desc(schema.learningReportSnapshots.createdAt))
    .limit(limit);
  return Promise.all(snapshots.map((snapshot) => snapshotWithArtifacts(snapshot, input.userId)));
}

export async function getLearningReportArtifact(input: {
  snapshotId: string;
  userId: string;
  format: "png" | "pdf";
}) {
  const [snapshot] = await getDatabase()
    .select()
    .from(schema.learningReportSnapshots)
    .where(
      and(
        eq(schema.learningReportSnapshots.id, input.snapshotId),
        eq(schema.learningReportSnapshots.userId, input.userId)
      )
    )
    .limit(1);
  if (!snapshot) throw new Error("LEARNING_REPORT_SNAPSHOT_NOT_FOUND");
  await snapshotWithArtifacts(snapshot, input.userId);
  const [artifact] = await getDatabase()
    .select()
    .from(schema.learningReportArtifacts)
    .where(
      and(
        eq(schema.learningReportArtifacts.snapshotId, snapshot.id),
        eq(schema.learningReportArtifacts.format, input.format)
      )
    )
    .limit(1);
  if (artifact) return artifact;
  throw new Error("LEARNING_REPORT_ARTIFACT_NOT_READY");
}

export async function claimLearningReportSnapshot(snapshotId: string) {
  const token = randomUUID();
  const [queued] = await getDatabase()
    .select()
    .from(schema.learningReportSnapshots)
    .where(
      and(
        eq(schema.learningReportSnapshots.id, snapshotId),
        eq(schema.learningReportSnapshots.status, "queued")
      )
    )
    .limit(1);
  if (!queued) return null;
  await snapshotWithArtifacts(queued, queued.userId);
  const [snapshot] = await getDatabase()
    .update(schema.learningReportSnapshots)
    .set({
      status: "rendering",
      executionToken: token,
      executionLeaseExpiresAt: new Date(Date.now() + LEARNING_REPORT_LEASE_MS),
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date()
    })
    .where(
      and(
        eq(schema.learningReportSnapshots.id, snapshotId),
        eq(schema.learningReportSnapshots.status, "queued")
      )
    )
    .returning();
  if (!snapshot) return null;
  const report = learningProgressReportSchema.parse(snapshot.report);
  if (report.learningPlanId !== snapshot.learningPlanId || report.courseId !== snapshot.courseId)
    throw new Error("LEARNING_REPORT_SNAPSHOT_INVALID");
  const rows = await getDatabase()
    .select({ organizationId: schema.knowledgeSpaces.organizationId })
    .from(schema.courseModules)
    .innerJoin(schema.courseUnits, eq(schema.courseUnits.courseModuleId, schema.courseModules.id))
    .innerJoin(
      schema.resourceVersions,
      eq(schema.courseUnits.resourceVersionId, schema.resourceVersions.id)
    )
    .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
    .innerJoin(schema.knowledgeSpaces, eq(schema.resources.spaceId, schema.knowledgeSpaces.id))
    .where(eq(schema.courseModules.courseId, snapshot.courseId));
  const organizationIds = [...new Set(rows.map(({ organizationId }) => organizationId))];
  if (organizationIds.length !== 1) throw new Error("LEARNING_REPORT_ORGANIZATION_AMBIGUOUS");
  return { snapshot, token, report, organizationId: organizationIds[0]! };
}

export async function completeLearningReportSnapshot(input: {
  snapshotId: string;
  token: string;
  artifacts: Array<{ format: "png" | "pdf"; blobUri: string; sha256: string; byteSize: number }>;
}) {
  if (
    input.artifacts.length !== 2 ||
    new Set(input.artifacts.map(({ format }) => format)).size !== 2
  )
    throw new Error("LEARNING_REPORT_ARTIFACT_SET_INVALID");
  if (
    input.artifacts.some(
      ({ blobUri, sha256, byteSize }) =>
        !/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(blobUri) ||
        !/^[a-f0-9]{64}$/.test(sha256) ||
        !Number.isSafeInteger(byteSize) ||
        byteSize <= 0
    )
  )
    throw new Error("LEARNING_REPORT_ARTIFACT_METADATA_INVALID");
  return getDatabase().transaction(async (tx) => {
    const [completed] = await tx
      .update(schema.learningReportSnapshots)
      .set({
        status: "completed",
        completedAt: new Date(),
        executionToken: null,
        executionLeaseExpiresAt: null,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(schema.learningReportSnapshots.id, input.snapshotId),
          eq(schema.learningReportSnapshots.status, "rendering"),
          eq(schema.learningReportSnapshots.executionToken, input.token)
        )
      )
      .returning();
    if (!completed) throw new Error("LEARNING_REPORT_EXECUTION_LEASE_LOST");
    await tx
      .insert(schema.learningReportArtifacts)
      .values(input.artifacts.map((artifact) => ({ snapshotId: completed.id, ...artifact })));
    return completed;
  });
}

export async function failLearningReportSnapshot(input: {
  snapshotId: string;
  token: string;
  errorCode: string;
  errorMessage: string;
}) {
  const [failed] = await getDatabase()
    .update(schema.learningReportSnapshots)
    .set({
      status: "failed",
      executionToken: null,
      executionLeaseExpiresAt: null,
      errorCode: input.errorCode.slice(0, 120),
      errorMessage: input.errorMessage.slice(0, 300),
      updatedAt: new Date()
    })
    .where(
      and(
        eq(schema.learningReportSnapshots.id, input.snapshotId),
        eq(schema.learningReportSnapshots.status, "rendering"),
        eq(schema.learningReportSnapshots.executionToken, input.token)
      )
    )
    .returning();
  return Boolean(failed);
}

export async function recoverExpiredLearningReportSnapshots() {
  const now = new Date();
  const stale = await getDatabase()
    .select({ id: schema.learningReportSnapshots.id })
    .from(schema.learningReportSnapshots)
    .where(
      and(
        eq(schema.learningReportSnapshots.status, "rendering"),
        lt(schema.learningReportSnapshots.executionLeaseExpiresAt, now)
      )
    );
  const ids = stale.map(({ id }) => id);
  if (!ids.length) return 0;
  await getDatabase().transaction(async (tx) => {
    await tx
      .update(schema.learningReportSnapshots)
      .set({
        status: "queued",
        executionToken: null,
        executionLeaseExpiresAt: null,
        updatedAt: now
      })
      .where(inArray(schema.learningReportSnapshots.id, ids));
    await tx
      .update(schema.learningReportOutbox)
      .set({
        status: "pending",
        dispatchToken: null,
        dispatchLeaseExpiresAt: null,
        updatedAt: now
      })
      .where(inArray(schema.learningReportOutbox.snapshotId, ids));
  });
  return ids.length;
}

export type { LearningProgressReport };
