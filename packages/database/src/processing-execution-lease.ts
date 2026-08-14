import { and, eq, gt, inArray, isNotNull, lt } from "drizzle-orm";
import { getDatabase, schema } from "./index";

export const DEFAULT_PROCESSING_LEASE_MS = 120_000;

function leaseExpiry(leaseMs: number): Date {
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000) throw new Error("PROCESSING_LEASE_INVALID");
  return new Date(Date.now() + leaseMs);
}

export async function claimProcessingExecution(
  jobId: string,
  token: string,
  leaseMs = DEFAULT_PROCESSING_LEASE_MS
): Promise<boolean> {
  const db = getDatabase();
  const update = {
    status: "processing" as const,
    stage: "parsing",
    progress: 10,
    errorCode: null,
    errorMessage: null,
    finishedAt: null,
    startedAt: new Date(),
    executionToken: token,
    executionLeaseExpiresAt: leaseExpiry(leaseMs),
    updatedAt: new Date()
  };
  const [queued] = await db
    .update(schema.processingJobs)
    .set(update)
    .where(and(eq(schema.processingJobs.id, jobId), eq(schema.processingJobs.status, "queued")))
    .returning({ id: schema.processingJobs.id });
  if (queued) return true;
  const [stale] = await db
    .update(schema.processingJobs)
    .set(update)
    .where(
      and(
        eq(schema.processingJobs.id, jobId),
        eq(schema.processingJobs.status, "processing"),
        isNotNull(schema.processingJobs.executionLeaseExpiresAt),
        lt(schema.processingJobs.executionLeaseExpiresAt, new Date())
      )
    )
    .returning({ id: schema.processingJobs.id });
  return Boolean(stale);
}

export async function refreshProcessingExecution(
  jobId: string,
  token: string,
  leaseMs = DEFAULT_PROCESSING_LEASE_MS
): Promise<boolean> {
  const [updated] = await getDatabase()
    .update(schema.processingJobs)
    .set({ executionLeaseExpiresAt: leaseExpiry(leaseMs), updatedAt: new Date() })
    .where(
      and(
        eq(schema.processingJobs.id, jobId),
        eq(schema.processingJobs.status, "processing"),
        eq(schema.processingJobs.executionToken, token),
        gt(schema.processingJobs.executionLeaseExpiresAt, new Date())
      )
    )
    .returning({ id: schema.processingJobs.id });
  return Boolean(updated);
}

export async function updateProcessingExecutionStage(
  jobId: string,
  token: string,
  stage: string,
  progress: number,
  leaseMs = DEFAULT_PROCESSING_LEASE_MS
): Promise<boolean> {
  const [updated] = await getDatabase()
    .update(schema.processingJobs)
    .set({
      stage,
      progress,
      executionLeaseExpiresAt: leaseExpiry(leaseMs),
      updatedAt: new Date()
    })
    .where(
      and(
        eq(schema.processingJobs.id, jobId),
        eq(schema.processingJobs.status, "processing"),
        eq(schema.processingJobs.executionToken, token),
        gt(schema.processingJobs.executionLeaseExpiresAt, new Date())
      )
    )
    .returning({ id: schema.processingJobs.id });
  return Boolean(updated);
}

export async function listExpiredProcessingExecutions() {
  return getDatabase()
    .select({
      id: schema.processingJobs.id,
      resourceVersionId: schema.processingJobs.resourceVersionId,
      status: schema.processingJobs.status
    })
    .from(schema.processingJobs)
    .where(
      and(
        inArray(schema.processingJobs.status, ["processing", "cancel_requested"]),
        isNotNull(schema.processingJobs.executionLeaseExpiresAt),
        lt(schema.processingJobs.executionLeaseExpiresAt, new Date())
      )
    );
}

export async function claimExpiredProcessingForRecovery(
  jobId: string,
  token: string,
  leaseMs = DEFAULT_PROCESSING_LEASE_MS
): Promise<boolean> {
  const [updated] = await getDatabase()
    .update(schema.processingJobs)
    .set({
      stage: "recovery_pending",
      executionToken: token,
      executionLeaseExpiresAt: leaseExpiry(leaseMs),
      updatedAt: new Date()
    })
    .where(
      and(
        eq(schema.processingJobs.id, jobId),
        eq(schema.processingJobs.status, "processing"),
        isNotNull(schema.processingJobs.executionLeaseExpiresAt),
        lt(schema.processingJobs.executionLeaseExpiresAt, new Date())
      )
    )
    .returning({ id: schema.processingJobs.id });
  return Boolean(updated);
}

export async function releaseRecoveredProcessingExecution(
  jobId: string,
  token: string,
  queueJobId: string
): Promise<boolean> {
  const [updated] = await getDatabase()
    .update(schema.processingJobs)
    .set({
      status: "queued",
      stage: "queued",
      progress: 0,
      queueJobId,
      executionToken: null,
      executionLeaseExpiresAt: null,
      updatedAt: new Date()
    })
    .where(
      and(
        eq(schema.processingJobs.id, jobId),
        eq(schema.processingJobs.status, "processing"),
        eq(schema.processingJobs.executionToken, token)
      )
    )
    .returning({ id: schema.processingJobs.id });
  return Boolean(updated);
}

export async function clearCancelledExpiredExecution(jobId: string): Promise<boolean> {
  const [updated] = await getDatabase()
    .update(schema.processingJobs)
    .set({
      status: "cancelled",
      stage: "cancelled",
      finishedAt: new Date(),
      executionToken: null,
      executionLeaseExpiresAt: null,
      updatedAt: new Date()
    })
    .where(
      and(
        eq(schema.processingJobs.id, jobId),
        eq(schema.processingJobs.status, "cancel_requested"),
        isNotNull(schema.processingJobs.executionLeaseExpiresAt),
        lt(schema.processingJobs.executionLeaseExpiresAt, new Date())
      )
    )
    .returning({ id: schema.processingJobs.id });
  return Boolean(updated);
}
