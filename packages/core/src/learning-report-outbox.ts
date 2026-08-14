import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, lt, or } from "drizzle-orm";
import { getDatabase, schema } from "@wknowledge/database";

export interface LearningReportOutboxQueue {
  publish(name: "learning.report.render", payload: { snapshotId: string }): Promise<string>;
}

const DEFAULT_LEASE_MS = 30_000;

function dispatchable(now: Date) {
  return or(
    eq(schema.learningReportOutbox.status, "pending"),
    and(
      eq(schema.learningReportOutbox.status, "dispatching"),
      isNotNull(schema.learningReportOutbox.dispatchLeaseExpiresAt),
      lt(schema.learningReportOutbox.dispatchLeaseExpiresAt, now)
    )
  );
}

export async function dispatchPendingLearningReportOutbox(
  queue: LearningReportOutboxQueue,
  limit = 25,
  leaseMs = DEFAULT_LEASE_MS,
  snapshotId?: string
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("LEARNING_REPORT_OUTBOX_LIMIT_INVALID");
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000)
    throw new Error("LEARNING_REPORT_OUTBOX_LEASE_INVALID");
  const db = getDatabase();
  let dispatched = 0;
  let failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const now = new Date();
    const [candidate] = await db
      .select()
      .from(schema.learningReportOutbox)
      .where(
        and(
          dispatchable(now),
          ...(snapshotId ? [eq(schema.learningReportOutbox.snapshotId, snapshotId)] : [])
        )
      )
      .orderBy(schema.learningReportOutbox.createdAt)
      .limit(1);
    if (!candidate) break;
    const token = randomUUID();
    const [claimed] = await db
      .update(schema.learningReportOutbox)
      .set({
        status: "dispatching",
        attemptCount: candidate.attemptCount + 1,
        dispatchToken: token,
        dispatchLeaseExpiresAt: new Date(Date.now() + leaseMs),
        updatedAt: now
      })
      .where(
        and(
          eq(schema.learningReportOutbox.id, candidate.id),
          dispatchable(now),
          ...(snapshotId ? [eq(schema.learningReportOutbox.snapshotId, snapshotId)] : [])
        )
      )
      .returning();
    if (!claimed) continue;
    const [snapshot] = await db
      .select({
        id: schema.learningReportSnapshots.id,
        status: schema.learningReportSnapshots.status
      })
      .from(schema.learningReportSnapshots)
      .where(eq(schema.learningReportSnapshots.id, claimed.snapshotId))
      .limit(1);
    if (!snapshot || snapshot.status !== "queued") {
      await db
        .update(schema.learningReportOutbox)
        .set({
          status: "discarded",
          dispatchToken: null,
          dispatchLeaseExpiresAt: null,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(schema.learningReportOutbox.id, claimed.id),
            eq(schema.learningReportOutbox.status, "dispatching"),
            eq(schema.learningReportOutbox.dispatchToken, token)
          )
        );
      continue;
    }
    try {
      const queueJobId = await queue.publish("learning.report.render", { snapshotId: snapshot.id });
      const [sent] = await db
        .update(schema.learningReportOutbox)
        .set({
          status: "sent",
          queueJobId,
          sentAt: new Date(),
          dispatchToken: null,
          dispatchLeaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorAt: null,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(schema.learningReportOutbox.id, claimed.id),
            eq(schema.learningReportOutbox.status, "dispatching"),
            eq(schema.learningReportOutbox.dispatchToken, token)
          )
        )
        .returning({ id: schema.learningReportOutbox.id });
      if (sent) dispatched += 1;
    } catch {
      await db
        .update(schema.learningReportOutbox)
        .set({
          status: "pending",
          dispatchToken: null,
          dispatchLeaseExpiresAt: null,
          lastErrorCode: "LEARNING_REPORT_QUEUE_PUBLISH_FAILED",
          lastErrorAt: new Date(),
          updatedAt: new Date()
        })
        .where(
          and(
            eq(schema.learningReportOutbox.id, claimed.id),
            eq(schema.learningReportOutbox.status, "dispatching"),
            eq(schema.learningReportOutbox.dispatchToken, token)
          )
        );
      failed += 1;
      break;
    }
  }
  return { dispatched, failed };
}
