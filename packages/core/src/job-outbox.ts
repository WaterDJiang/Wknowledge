import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, lt, or } from "drizzle-orm";
import { getDatabase, schema } from "@wknowledge/database";

export interface ProcessingOutboxQueue {
  publish(
    name: "resource.process" | "resource.upload.finalize",
    payload: { jobId: string; resourceVersionId: string } | { jobId: string; uploadId: string }
  ): Promise<string>;
}

export const DEFAULT_OUTBOX_DISPATCH_LEASE_MS = 30_000;

function dispatchLeaseExpiry(leaseMs: number): Date {
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000)
    throw new Error("OUTBOX_DISPATCH_LEASE_INVALID");
  return new Date(Date.now() + leaseMs);
}

function dispatchableCondition(now: Date) {
  return or(
    eq(schema.jobOutbox.status, "pending"),
    and(
      eq(schema.jobOutbox.status, "dispatching"),
      isNotNull(schema.jobOutbox.dispatchLeaseExpiresAt),
      lt(schema.jobOutbox.dispatchLeaseExpiresAt, now)
    )
  );
}

export async function dispatchPendingProcessingOutbox(
  queue: ProcessingOutboxQueue,
  limit = 25,
  leaseMs = DEFAULT_OUTBOX_DISPATCH_LEASE_MS,
  processingJobId?: string
): Promise<{ dispatched: number; discarded: number; failed: number }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("OUTBOX_LIMIT_INVALID");
  const db = getDatabase();
  let dispatched = 0;
  let discarded = 0;
  let failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const now = new Date();
    const [candidate] = await db
      .select()
      .from(schema.jobOutbox)
      .where(
        processingJobId
          ? and(dispatchableCondition(now), eq(schema.jobOutbox.processingJobId, processingJobId))
          : dispatchableCondition(now)
      )
      .orderBy(schema.jobOutbox.createdAt)
      .limit(1);
    if (!candidate) break;

    const token = randomUUID();
    const [claimed] = await db
      .update(schema.jobOutbox)
      .set({
        status: "dispatching",
        attemptCount: candidate.attemptCount + 1,
        dispatchToken: token,
        dispatchLeaseExpiresAt: dispatchLeaseExpiry(leaseMs),
        updatedAt: now
      })
      .where(
        and(
          eq(schema.jobOutbox.id, candidate.id),
          dispatchableCondition(now),
          ...(processingJobId ? [eq(schema.jobOutbox.processingJobId, processingJobId)] : [])
        )
      )
      .returning();
    if (!claimed) continue;

    const [job] = await db
      .select({ id: schema.processingJobs.id, status: schema.processingJobs.status })
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, claimed.processingJobId))
      .limit(1);
    if (!job || job.status !== "queued") {
      await db
        .update(schema.jobOutbox)
        .set({
          status: "discarded",
          dispatchToken: null,
          dispatchLeaseExpiresAt: null,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(schema.jobOutbox.id, claimed.id),
            eq(schema.jobOutbox.status, "dispatching"),
            eq(schema.jobOutbox.dispatchToken, token)
          )
        );
      discarded += 1;
      continue;
    }

    try {
      const queueJobId =
        claimed.kind === "resource.upload.finalize"
          ? claimed.uploadId
            ? await queue.publish("resource.upload.finalize", {
                jobId: claimed.processingJobId,
                uploadId: claimed.uploadId
              })
            : (() => {
                throw new Error("OUTBOX_UPLOAD_ID_REQUIRED");
              })()
          : claimed.resourceVersionId
            ? await queue.publish("resource.process", {
                jobId: claimed.processingJobId,
                resourceVersionId: claimed.resourceVersionId
              })
            : (() => {
                throw new Error("OUTBOX_RESOURCE_VERSION_REQUIRED");
              })();
      const sent = await db.transaction(async (tx) => {
        const [outbox] = await tx
          .update(schema.jobOutbox)
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
              eq(schema.jobOutbox.id, claimed.id),
              eq(schema.jobOutbox.status, "dispatching"),
              eq(schema.jobOutbox.dispatchToken, token)
            )
          )
          .returning({ id: schema.jobOutbox.id });
        if (!outbox) return false;
        await tx
          .update(schema.processingJobs)
          .set({ queueJobId, updatedAt: new Date() })
          .where(eq(schema.processingJobs.id, claimed.processingJobId));
        return true;
      });
      if (sent) dispatched += 1;
    } catch {
      await db
        .update(schema.jobOutbox)
        .set({
          status: "pending",
          dispatchToken: null,
          dispatchLeaseExpiresAt: null,
          lastErrorCode: "QUEUE_PUBLISH_FAILED",
          lastErrorAt: new Date(),
          updatedAt: new Date()
        })
        .where(
          and(
            eq(schema.jobOutbox.id, claimed.id),
            eq(schema.jobOutbox.status, "dispatching"),
            eq(schema.jobOutbox.dispatchToken, token)
          )
        );
      failed += 1;
      break;
    }
  }
  return { dispatched, discarded, failed };
}
