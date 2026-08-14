import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { and, asc, desc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import { hashPassword } from "@wknowledge/auth";
import type {
  BlobAuditSummary,
  DataPolicy,
  DeadLetterQueueHealth,
  Role,
  WikiCompileProfile
} from "@wknowledge/contracts";
import type { BlobStore, LocalBlobInventory } from "@wknowledge/blob-store";
import {
  claimExpiredProcessingForRecovery,
  clearCancelledExpiredExecution,
  getDatabase,
  listExpiredProcessingExecutions,
  releaseRecoveredProcessingExecution,
  schema
} from "@wknowledge/database";
import { initializeSpace } from "@wknowledge/wiki";
import { PgBoss, type QueueStats } from "pg-boss";
import { DEFAULT_OUTBOX_DISPATCH_LEASE_MS, dispatchPendingProcessingOutbox } from "./job-outbox";

export { publishCompiledFromStaging } from "./compiled-publish";
export {
  exportOrganizationAuditEvents,
  readAuditRetentionDays,
  resolveAuditExportRange,
  type AuditExportRange
} from "./audit-export";
export {
  createModelInvocationBudgetGuard,
  readModelInvocationBudgetLimits,
  DEFAULT_MODEL_INVOCATION_BUDGET_LIMITS,
  type ModelInvocationBudgetLimits,
  type ModelInvocationGuard,
  type ModelInvocationGuardInput
} from "./model-invocation-budget";
export {
  assessOrganizationOperationsAlerts,
  readOrganizationOperationsSnapshot,
  type OrganizationOperationsAlertCode,
  type OrganizationOperationsSnapshot
} from "./operations-health";
export { dispatchPendingProcessingOutbox, type ProcessingOutboxQueue } from "./job-outbox";
export {
  addAgentSessionContextBinding,
  addAgentSessionSpaceBinding,
  assertAgentSessionBindingsReadable,
  beginAgentSessionRun,
  completeAgentSessionRun,
  contextBindingStatus,
  createAgentSession,
  getAgentRunEvents,
  getAgentSessionDetail,
  listAgentSessions,
  persistAgentSessionTurn,
  removeAgentSessionSpaceBinding,
  resolveAgentSessionContext,
  settleAgentSessionRun,
  stopAgentSessionRun,
  updateAgentSession,
  type ResolvedAgentSessionContext
} from "./agent-sessions";
export {
  decideSkillApproval,
  listSessionSkillApprovals,
  listSessionSkillPolicies,
  presentSkillApproval,
  requestSkillApproval
} from "./skill-approvals";
export { sessionSkillExecution, type SessionSkillExecution } from "./session-skill-execution";
export {
  assertLearningPlanSourcesReadable,
  assertLearningResourceVersionsReadable,
  learningPlanResourceVersionIds
} from "./learning-source-access";
export {
  createQueuedSkillRun,
  getSkillRun,
  listSessionSkillRuns,
  presentSkillRun
} from "./skill-runs";
export {
  getPlanComposeGenerationRequestForRun,
  getPracticeGenerateGenerationRequestForRun,
  queuePlanComposeGeneration,
  queuePracticeGenerateGeneration
} from "./learning-generation-requests";
export { dispatchPendingSkillRunOutbox, type SkillRunOutboxQueue } from "./skill-run-outbox";
export { executeBuiltinSkillRun } from "./builtin-skill-execution";
export {
  executeDynamicSkillRun,
  persistPlanComposeCandidate,
  persistPracticeGenerateCandidate
} from "./dynamic-skill-execution";
export {
  hasAvailableAsrProvider,
  hasAvailableVisionProvider,
  isAsrProviderLocationCompatible,
  isVisionProviderLocationCompatible
} from "./asr-provider-availability";
export {
  confirmLearningPlan,
  createLearningPlanDraft,
  materializePlanComposeCandidate,
  getActiveLearningCourse,
  getActiveLearningPlan,
  getActiveLearningProgress,
  getLearnerProfile,
  listLearningContentOptions,
  listPlanComposeCandidates,
  listLearningPlans,
  recordActiveLearningEvent,
  updateLearnerDeclared
} from "./learning-plans";
export { getActiveLearningProgressReport } from "./learning-progress-report";
export { getActiveCourseMasterySummary } from "./knowledge-point-mastery";
export {
  claimLearningReportSnapshot,
  completeLearningReportSnapshot,
  createActiveLearningReportSnapshot,
  failLearningReportSnapshot,
  getLearningReportArtifact,
  getLearningReportSnapshot,
  listLearningReportSnapshots,
  recoverExpiredLearningReportSnapshots
} from "./learning-report-artifacts";
export {
  dispatchPendingLearningReportOutbox,
  type LearningReportOutboxQueue
} from "./learning-report-outbox";
export { listActivePracticeMistakeReviews } from "./practice-mistake-review";
export {
  listManualFreeResponseReviews,
  submitManualFreeResponseReview
} from "./manual-free-response-reviews";
export {
  createPracticeCandidate,
  listPracticeCandidates,
  listPracticeGenerateCandidates,
  materializePracticeGenerateCandidate,
  validatePracticeGenerateCandidateOutput,
  submitPracticeAttempt
} from "./practice-candidates";
export {
  createAssessment,
  createAssessmentFromPracticeGenerateCandidate,
  listAssessments,
  startAssessment,
  submitAssessment,
  submitAssessmentAttempt
} from "./assessments";

export interface JobQueue {
  publish(
    name: "resource.process" | "resource.upload.finalize",
    payload: { jobId: string; resourceVersionId: string } | { jobId: string; uploadId: string }
  ): Promise<string>;
  cancel(name: "resource.process", queueJobId: string): Promise<boolean>;
  resume(name: "resource.process", queueJobId: string): Promise<boolean>;
}

const DIRECT_UPLOAD_RESERVATION_MS = 15 * 60 * 1_000;
const DERIVED_STORAGE_RESERVATION_MS = 15 * 60 * 1_000;
const DERIVED_STORAGE_KEY =
  /^(?:compiled:[0-9a-f-]{36}:[0-9a-f-]{36}|learning-report:[0-9a-f-]{36})$/i;

type StorageUsage = {
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  availableBytes: number;
};

type StorageUsageReader = Pick<ReturnType<typeof getDatabase>, "select" | "insert" | "delete">;

async function storageUsageInTransaction(
  tx: StorageUsageReader,
  organizationId: string
): Promise<StorageUsage> {
  const [organization] = await tx
    .select({ storageQuotaBytes: schema.organizations.storageQuotaBytes })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .for("update")
    .limit(1);
  if (!organization) throw new Error("STORAGE_ORGANIZATION_NOT_FOUND");
  const versions = await tx
    .select({
      blobUri: schema.resourceVersions.blobUri,
      byteSize: schema.resourceVersions.byteSize
    })
    .from(schema.resourceVersions)
    .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
    .innerJoin(schema.knowledgeSpaces, eq(schema.resources.spaceId, schema.knowledgeSpaces.id))
    .where(eq(schema.knowledgeSpaces.organizationId, organizationId));
  const uniqueBlobs = new Map<string, number>();
  for (const version of versions) uniqueBlobs.set(version.blobUri, version.byteSize);
  const derivedAssets = await tx
    .select({ byteSize: schema.derivedStorageAssets.byteSize })
    .from(schema.derivedStorageAssets)
    .where(eq(schema.derivedStorageAssets.organizationId, organizationId));
  const reservations = await tx
    .select({ byteSize: schema.storageReservations.byteSize })
    .from(schema.storageReservations)
    .where(
      and(
        eq(schema.storageReservations.organizationId, organizationId),
        gt(schema.storageReservations.expiresAt, new Date())
      )
    );
  const usedBytes =
    [...uniqueBlobs.values()].reduce((total, value) => total + value, 0) +
    derivedAssets.reduce((total, value) => total + value.byteSize, 0);
  const reservedBytes = reservations.reduce((total, value) => total + value.byteSize, 0);
  return {
    quotaBytes: organization.storageQuotaBytes,
    usedBytes,
    reservedBytes,
    availableBytes: Math.max(0, organization.storageQuotaBytes - usedBytes - reservedBytes)
  };
}

async function organizationIdForSpace(spaceId: string) {
  const [space] = await getDatabase()
    .select({ organizationId: schema.knowledgeSpaces.organizationId })
    .from(schema.knowledgeSpaces)
    .where(eq(schema.knowledgeSpaces.id, spaceId))
    .limit(1);
  if (!space) throw new Error("SPACE_NOT_FOUND");
  return space.organizationId;
}

export async function readOrganizationStorageUsage(organizationId: string): Promise<StorageUsage> {
  return getDatabase().transaction((tx) => storageUsageInTransaction(tx, organizationId));
}

export type DerivedStorageWriteReservation = {
  commit(): Promise<void>;
  release(): Promise<void>;
};

export async function reserveDerivedStorageWrite(input: {
  organizationId: string;
  assetKey: string;
  byteSize: number;
}): Promise<DerivedStorageWriteReservation> {
  if (!DERIVED_STORAGE_KEY.test(input.assetKey)) throw new Error("DERIVED_STORAGE_KEY_INVALID");
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0)
    throw new Error("DERIVED_STORAGE_SIZE_INVALID");
  const reservationId = await getDatabase().transaction(async (tx) => {
    const usage = await storageUsageInTransaction(tx, input.organizationId);
    const [existing] = await tx
      .select({ byteSize: schema.derivedStorageAssets.byteSize })
      .from(schema.derivedStorageAssets)
      .where(
        and(
          eq(schema.derivedStorageAssets.organizationId, input.organizationId),
          eq(schema.derivedStorageAssets.assetKey, input.assetKey)
        )
      )
      .limit(1);
    const growthBytes = Math.max(0, input.byteSize - (existing?.byteSize ?? 0));
    if (usage.usedBytes + usage.reservedBytes + growthBytes > usage.quotaBytes)
      throw new Error("STORAGE_QUOTA_EXCEEDED");
    if (!growthBytes) return null;
    const id = randomUUID();
    await tx.insert(schema.storageReservations).values({
      id,
      organizationId: input.organizationId,
      byteSize: growthBytes,
      expiresAt: new Date(Date.now() + DERIVED_STORAGE_RESERVATION_MS)
    });
    return id;
  });
  let settled = false;
  return {
    async commit() {
      if (settled) return;
      await getDatabase().transaction(async (tx) => {
        await storageUsageInTransaction(tx, input.organizationId);
        await tx
          .insert(schema.derivedStorageAssets)
          .values({
            organizationId: input.organizationId,
            assetKey: input.assetKey,
            byteSize: input.byteSize,
            updatedAt: new Date()
          })
          .onConflictDoUpdate({
            target: [
              schema.derivedStorageAssets.organizationId,
              schema.derivedStorageAssets.assetKey
            ],
            set: { byteSize: input.byteSize, updatedAt: new Date() }
          });
        if (reservationId)
          await tx
            .delete(schema.storageReservations)
            .where(eq(schema.storageReservations.id, reservationId));
      });
      settled = true;
    },
    async release() {
      if (settled || !reservationId) return;
      await getDatabase()
        .delete(schema.storageReservations)
        .where(
          and(
            eq(schema.storageReservations.id, reservationId),
            eq(schema.storageReservations.organizationId, input.organizationId)
          )
        );
      settled = true;
    }
  };
}

async function reserveStorage(input: {
  organizationId: string;
  byteSize: number;
  expiresAt: Date;
}): Promise<string> {
  if (!Number.isInteger(input.byteSize) || input.byteSize <= 0)
    throw new Error("STORAGE_RESERVATION_INVALID");
  return getDatabase().transaction(async (tx) => {
    const usage = await storageUsageInTransaction(tx, input.organizationId);
    if (usage.usedBytes + usage.reservedBytes + input.byteSize > usage.quotaBytes)
      throw new Error("STORAGE_QUOTA_EXCEEDED");
    const id = randomUUID();
    await tx.insert(schema.storageReservations).values({
      id,
      organizationId: input.organizationId,
      byteSize: input.byteSize,
      expiresAt: input.expiresAt
    });
    return id;
  });
}

async function releaseStorageReservation(reservationId: string | null | undefined) {
  if (!reservationId) return;
  await getDatabase()
    .delete(schema.storageReservations)
    .where(eq(schema.storageReservations.id, reservationId));
}

export class PgBossJobQueue implements JobQueue {
  private readonly boss: PgBoss;
  private started = false;
  private static readonly deadLetterQueue = "resource.process.dead-letter";

  constructor(connectionString: string) {
    this.boss = new PgBoss(connectionString);
  }

  async publish(
    name: "resource.process" | "resource.upload.finalize",
    payload: { jobId: string; resourceVersionId: string } | { jobId: string; uploadId: string }
  ): Promise<string> {
    if (!this.started) {
      await this.boss.start();
      this.started = true;
    }
    await this.boss.createQueue(PgBossJobQueue.deadLetterQueue);
    await this.boss.createQueue(name, { deadLetter: PgBossJobQueue.deadLetterQueue });
    await this.boss.updateQueue(name, { deadLetter: PgBossJobQueue.deadLetterQueue });
    const id = await this.boss.send(name, payload, {
      retryLimit: 3,
      retryDelay: 10,
      expireInSeconds: 900
    });
    if (!id) throw new Error("QUEUE_PUBLISH_FAILED");
    return id;
  }

  async cancel(name: "resource.process", queueJobId: string): Promise<boolean> {
    if (!this.started) {
      await this.boss.start();
      this.started = true;
    }
    const response = (await this.boss.cancel(name, queueJobId)) as { affected: number };
    return response.affected === 1;
  }

  async resume(name: "resource.process", queueJobId: string): Promise<boolean> {
    if (!this.started) {
      await this.boss.start();
      this.started = true;
    }
    const response = (await this.boss.resume(name, queueJobId)) as { affected: number };
    return response.affected === 1;
  }

  async stop(): Promise<void> {
    if (this.started) await this.boss.stop();
    this.started = false;
  }
}

const RESOURCE_PROCESS_QUEUE = "resource.process";
const RESOURCE_PROCESS_DEAD_LETTER_QUEUE = "resource.process.dead-letter";

export interface ResourceQueueHealthOptions {
  processingQueue?: string;
  deadLetterQueue?: string;
}

function resourceQueueNames(options: ResourceQueueHealthOptions) {
  return {
    processingQueue: options.processingQueue ?? RESOURCE_PROCESS_QUEUE,
    deadLetterQueue: options.deadLetterQueue ?? RESOURCE_PROCESS_DEAD_LETTER_QUEUE
  };
}

function queueHealthFromStats(name: string, stats?: QueueStats) {
  return {
    name,
    queuedCount: stats?.queuedCount ?? 0,
    activeCount: stats?.activeCount ?? 0,
    failedCount: stats?.failedCount ?? 0,
    totalCount: stats?.totalCount ?? 0
  };
}

export async function readResourceQueueHealth(
  connectionString: string,
  options: ResourceQueueHealthOptions = {}
): Promise<DeadLetterQueueHealth> {
  const names = resourceQueueNames(options);
  const boss = new PgBoss(connectionString);
  await boss.start();
  try {
    const [processingStats, deadLetterStats, deadLetters] = await Promise.all([
      boss.getQueueStats(names.processingQueue, { force: true, limit: 1 }),
      boss.getQueueStats(names.deadLetterQueue, { force: true, limit: 1 }),
      boss.findJobs(names.deadLetterQueue, { queued: true })
    ]);
    const jobs = deadLetters
      .filter((job) => job.sourceName === names.processingQueue)
      .sort((left, right) => left.createdOn.getTime() - right.createdOn.getTime())
      .slice(0, 20)
      .map((job) => ({
        id: job.id,
        sourceName: job.sourceName,
        retryCount: job.sourceRetryCount,
        createdAt: job.createdOn.toISOString()
      }));
    return {
      processing: queueHealthFromStats(names.processingQueue, processingStats[0]),
      deadLetter: queueHealthFromStats(names.deadLetterQueue, deadLetterStats[0]),
      oldestDeadLetterAt: jobs[0]?.createdAt ?? null,
      jobs
    };
  } finally {
    await boss.stop();
  }
}

export async function redriveResourceDeadLetters(
  connectionString: string,
  limit: number,
  options: ResourceQueueHealthOptions = {}
): Promise<number> {
  const names = resourceQueueNames(options);
  const boss = new PgBoss(connectionString);
  await boss.start();
  try {
    return await boss.redrive(names.deadLetterQueue, {
      sourceName: names.processingQueue,
      limit
    });
  } finally {
    await boss.stop();
  }
}

type OrganizationResourceJob = Pick<
  typeof schema.processingJobs.$inferSelect,
  "id" | "spaceId" | "resourceVersionId" | "status" | "createdAt"
>;

async function listOrganizationCurrentResourceJobs(
  organizationId: string
): Promise<OrganizationResourceJob[]> {
  const rows = await getDatabase()
    .select({ job: schema.processingJobs })
    .from(schema.processingJobs)
    .innerJoin(schema.knowledgeSpaces, eq(schema.processingJobs.spaceId, schema.knowledgeSpaces.id))
    .where(
      and(
        eq(schema.knowledgeSpaces.organizationId, organizationId),
        eq(schema.processingJobs.kind, RESOURCE_PROCESS_QUEUE)
      )
    )
    .orderBy(desc(schema.processingJobs.createdAt));
  const latestByResourceVersion = new Map<string, OrganizationResourceJob>();
  for (const { job } of rows) {
    if (!job.resourceVersionId || latestByResourceVersion.has(job.resourceVersionId)) continue;
    latestByResourceVersion.set(job.resourceVersionId, job);
  }
  return [...latestByResourceVersion.values()];
}

export async function readOrganizationResourceQueueHealth(
  organizationId: string
): Promise<DeadLetterQueueHealth> {
  const jobs = await listOrganizationCurrentResourceJobs(organizationId);
  const failed = jobs
    .filter((job) => job.status === "failed")
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  return {
    processing: {
      name: RESOURCE_PROCESS_QUEUE,
      queuedCount: jobs.filter((job) => job.status === "queued").length,
      activeCount: jobs.filter(
        (job) => job.status === "processing" || job.status === "cancel_requested"
      ).length,
      failedCount: failed.length,
      totalCount: jobs.length
    },
    deadLetter: {
      name: `${RESOURCE_PROCESS_QUEUE}.retry`,
      queuedCount: failed.length,
      activeCount: 0,
      failedCount: 0,
      totalCount: failed.length
    },
    oldestDeadLetterAt: failed[0]?.createdAt.toISOString() ?? null,
    jobs: failed.slice(0, 20).map((job) => ({
      id: job.id,
      sourceName: RESOURCE_PROCESS_QUEUE,
      retryCount: 0,
      createdAt: job.createdAt.toISOString()
    }))
  };
}

export async function retryOrganizationFailedProcessingJobs(
  input: { organizationId: string; limit: number },
  queue: JobQueue
): Promise<{ moved: number; skipped: number }> {
  const jobs = await listOrganizationCurrentResourceJobs(input.organizationId);
  let moved = 0;
  let skipped = 0;
  for (const job of jobs.filter((item) => item.status === "failed").slice(0, input.limit)) {
    try {
      await retryProcessingJob({ jobId: job.id, spaceId: job.spaceId }, queue);
      moved += 1;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "JOB_NOT_RETRYABLE" || error.message === "JOB_RETRY_ALREADY_ACTIVE")
      ) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { moved, skipped };
}

function auditUriDigest(uri: string): string {
  return createHash("sha256").update(uri).digest("hex").slice(0, 16);
}

export async function auditLocalBlobConsistency(input: {
  organizationId: string;
  blobStore: Pick<BlobStore, "exists"> & LocalBlobInventory;
}): Promise<BlobAuditSummary> {
  const references = await getDatabase()
    .select({
      resourceVersionId: schema.resourceVersions.id,
      blobUri: schema.resourceVersions.blobUri,
      spaceId: schema.resources.spaceId
    })
    .from(schema.resourceVersions)
    .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
    .innerJoin(schema.knowledgeSpaces, eq(schema.resources.spaceId, schema.knowledgeSpaces.id))
    .where(eq(schema.knowledgeSpaces.organizationId, input.organizationId));
  const organizationSpaceIds = new Set(references.map((reference) => reference.spaceId));
  const inventory = (await input.blobStore.listImmutableUris()).filter((uri) => {
    if (!uri.startsWith("local://")) return false;
    const relative = uri.slice("local://".length);
    const spaceId = relative.split("/", 1)[0];
    return spaceId ? organizationSpaceIds.has(spaceId) : false;
  });
  const referencedUris = new Set(references.map((reference) => reference.blobUri));
  const missingResourceVersionIds: string[] = [];
  let verifiedReferenceCount = 0;
  let uncheckedReferenceCount = 0;
  for (const reference of references) {
    if (!reference.blobUri.startsWith("local://")) {
      uncheckedReferenceCount += 1;
      continue;
    }
    if (await input.blobStore.exists(reference.blobUri)) verifiedReferenceCount += 1;
    else if (missingResourceVersionIds.length < 20)
      missingResourceVersionIds.push(reference.resourceVersionId);
  }
  const unreferenced = inventory.filter((uri) => !referencedUris.has(uri));
  return {
    checkedAt: new Date().toISOString(),
    referencedCount: references.length,
    inventoryCount: inventory.length,
    verifiedReferenceCount,
    missingReferenceCount: references.length - verifiedReferenceCount - uncheckedReferenceCount,
    unreferencedBlobCount: unreferenced.length,
    uncheckedReferenceCount,
    missingResourceVersionIds,
    unreferencedUriDigests: unreferenced.slice(0, 20).map(auditUriDigest)
  };
}

export async function recoverExpiredProcessingJobs(
  queue: Pick<JobQueue, "publish">,
  options: { jobIds?: readonly string[] } = {}
): Promise<{
  requeued: number;
  cancelled: number;
}> {
  const db = getDatabase();
  let requeued = 0;
  let cancelled = 0;
  const allowedJobIds = options.jobIds ? new Set(options.jobIds) : null;
  for (const candidate of await listExpiredProcessingExecutions()) {
    if (allowedJobIds && !allowedJobIds.has(candidate.id)) continue;
    if (!candidate.resourceVersionId) continue;
    const [version] = await db
      .select({ id: schema.resourceVersions.id, resourceId: schema.resourceVersions.resourceId })
      .from(schema.resourceVersions)
      .where(eq(schema.resourceVersions.id, candidate.resourceVersionId))
      .limit(1);
    if (!version) continue;
    if (candidate.status === "cancel_requested") {
      if (await clearCancelledExpiredExecution(candidate.id)) {
        await db
          .update(schema.resources)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(schema.resources.id, version.resourceId));
        cancelled += 1;
      }
      continue;
    }

    const recoveryToken = randomUUID();
    if (!(await claimExpiredProcessingForRecovery(candidate.id, recoveryToken))) continue;
    try {
      const queueJobId = await queue.publish("resource.process", {
        jobId: candidate.id,
        resourceVersionId: version.id
      });
      if (await releaseRecoveredProcessingExecution(candidate.id, recoveryToken, queueJobId)) {
        await db
          .update(schema.resources)
          .set({ status: "queued", updatedAt: new Date() })
          .where(eq(schema.resources.id, version.resourceId));
        requeued += 1;
      }
    } catch {
      // Keep the recovery lease. A later Worker startup may safely claim it after expiry.
      console.error("Processing recovery publish failed", { jobId: candidate.id });
    }
  }
  return { requeued, cancelled };
}

const invitationTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const invitationExpiry = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);

export async function listOrganizationUsers(organizationId: string) {
  return getDatabase()
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      disabled: schema.organizationMemberships.disabled,
      role: schema.organizationMemberships.role,
      joinedAt: schema.organizationMemberships.createdAt
    })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.organizationMemberships.userId, schema.users.id))
    .where(eq(schema.organizationMemberships.organizationId, organizationId))
    .orderBy(schema.organizationMemberships.createdAt);
}

export async function listOrganizationInvitations(organizationId: string) {
  return getDatabase()
    .select({
      id: schema.organizationInvitations.id,
      email: schema.organizationInvitations.email,
      organizationRole: schema.organizationInvitations.organizationRole,
      spaceId: schema.organizationInvitations.spaceId,
      spaceRole: schema.organizationInvitations.spaceRole,
      expiresAt: schema.organizationInvitations.expiresAt,
      acceptedAt: schema.organizationInvitations.acceptedAt,
      revokedAt: schema.organizationInvitations.revokedAt,
      createdAt: schema.organizationInvitations.createdAt
    })
    .from(schema.organizationInvitations)
    .where(eq(schema.organizationInvitations.organizationId, organizationId))
    .orderBy(desc(schema.organizationInvitations.createdAt));
}

export async function createOrganizationInvitation(input: {
  organizationId: string;
  invitedBy: string;
  email: string;
  organizationRole: Exclude<Role, "owner">;
  spaceId?: string;
  spaceRole?: Role;
}) {
  if (input.spaceRole === "owner") throw new Error("INVITATION_SPACE_OWNER_FORBIDDEN");
  if (input.spaceRole && !input.spaceId) throw new Error("INVITATION_SPACE_REQUIRED");
  const db = getDatabase();
  if (input.spaceId) {
    const [space] = await db
      .select({ id: schema.knowledgeSpaces.id })
      .from(schema.knowledgeSpaces)
      .where(
        and(
          eq(schema.knowledgeSpaces.id, input.spaceId),
          eq(schema.knowledgeSpaces.organizationId, input.organizationId)
        )
      )
      .limit(1);
    if (!space) throw new Error("INVITATION_SPACE_NOT_FOUND");
  }
  const token = randomBytes(32).toString("base64url");
  const [invitation] = await db
    .insert(schema.organizationInvitations)
    .values({
      organizationId: input.organizationId,
      email: input.email.toLowerCase(),
      organizationRole: input.organizationRole,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      ...(input.spaceRole ? { spaceRole: input.spaceRole } : {}),
      tokenHash: invitationTokenHash(token),
      invitedBy: input.invitedBy,
      expiresAt: invitationExpiry()
    })
    .returning();
  if (!invitation) throw new Error("INVITATION_CREATE_FAILED");
  await db.insert(schema.auditEvents).values({
    organizationId: input.organizationId,
    actorUserId: input.invitedBy,
    action: "organization.invitation.created",
    targetType: "organization_invitation",
    targetId: invitation.id,
    metadata: {
      email: invitation.email,
      spaceId: invitation.spaceId,
      organizationRole: invitation.organizationRole
    }
  });
  return { invitation, token };
}

export async function revokeOrganizationInvitation(input: {
  organizationId: string;
  invitationId: string;
  actorUserId: string;
}) {
  const db = getDatabase();
  const [invitation] = await db
    .update(schema.organizationInvitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.organizationInvitations.id, input.invitationId),
        eq(schema.organizationInvitations.organizationId, input.organizationId),
        isNull(schema.organizationInvitations.acceptedAt),
        isNull(schema.organizationInvitations.revokedAt)
      )
    )
    .returning();
  if (!invitation) throw new Error("INVITATION_NOT_REVOCABLE");
  await db.insert(schema.auditEvents).values({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: "organization.invitation.revoked",
    targetType: "organization_invitation",
    targetId: invitation.id
  });
  return invitation;
}

export async function acceptOrganizationInvitation(input: {
  token: string;
  name: string;
  password?: string;
}) {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(schema.organizationInvitations)
      .where(eq(schema.organizationInvitations.tokenHash, invitationTokenHash(input.token)))
      .limit(1);
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt <= new Date()
    )
      throw new Error("INVITATION_INVALID");
    const [existingUser] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, invitation.email))
      .limit(1);
    if (!existingUser && !input.password) throw new Error("INVITATION_PASSWORD_REQUIRED");
    const [user] = existingUser
      ? [existingUser]
      : await tx
          .insert(schema.users)
          .values({
            email: invitation.email,
            name: input.name,
            passwordHash: await hashPassword(input.password!)
          })
          .returning();
    if (!user) throw new Error("INVITATION_USER_CREATE_FAILED");
    if (user.disabled) throw new Error("INVITATION_USER_DISABLED");
    await tx
      .insert(schema.organizationMemberships)
      .values({
        organizationId: invitation.organizationId,
        userId: user.id,
        role: invitation.organizationRole
      })
      .onConflictDoNothing();
    if (invitation.spaceId && invitation.spaceRole) {
      await tx
        .insert(schema.spaceMemberships)
        .values({ spaceId: invitation.spaceId, userId: user.id, role: invitation.spaceRole })
        .onConflictDoNothing();
    }
    const [accepted] = await tx
      .update(schema.organizationInvitations)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(schema.organizationInvitations.id, invitation.id),
          isNull(schema.organizationInvitations.acceptedAt),
          isNull(schema.organizationInvitations.revokedAt)
        )
      )
      .returning();
    if (!accepted) throw new Error("INVITATION_INVALID");
    await tx.insert(schema.auditEvents).values({
      organizationId: invitation.organizationId,
      actorUserId: user.id,
      action: "organization.invitation.accepted",
      targetType: "organization_invitation",
      targetId: invitation.id,
      metadata: { spaceId: invitation.spaceId }
    });
    return { user, invitation: accepted };
  });
}

export async function setOrganizationUserDisabled(input: {
  organizationId: string;
  userId: string;
  actorUserId: string;
  disabled: boolean;
}) {
  if (input.userId === input.actorUserId) throw new Error("USER_SELF_DISABLE_FORBIDDEN");
  const db = getDatabase();
  const [membership] = await db
    .select({ role: schema.organizationMemberships.role })
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, input.organizationId),
        eq(schema.organizationMemberships.userId, input.userId)
      )
    )
    .limit(1);
  if (!membership) throw new Error("ORGANIZATION_USER_NOT_FOUND");
  if (membership.role === "owner") throw new Error("OWNER_DISABLE_FORBIDDEN");
  const [updated] = await db
    .update(schema.organizationMemberships)
    .set({ disabled: input.disabled })
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, input.organizationId),
        eq(schema.organizationMemberships.userId, input.userId)
      )
    )
    .returning();
  if (!updated) throw new Error("ORGANIZATION_USER_NOT_FOUND");
  await db.insert(schema.auditEvents).values({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: input.disabled ? "organization.user.disabled" : "organization.user.enabled",
    targetType: "user",
    targetId: input.userId
  });
  return {
    id: input.userId,
    disabled: updated.disabled,
    role: updated.role,
    organizationId: updated.organizationId
  };
}

export async function listSpaceMembers(spaceId: string) {
  return getDatabase()
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      disabled: schema.organizationMemberships.disabled,
      role: schema.spaceMemberships.role,
      joinedAt: schema.spaceMemberships.createdAt
    })
    .from(schema.spaceMemberships)
    .innerJoin(schema.users, eq(schema.spaceMemberships.userId, schema.users.id))
    .innerJoin(
      schema.knowledgeSpaces,
      eq(schema.spaceMemberships.spaceId, schema.knowledgeSpaces.id)
    )
    .innerJoin(
      schema.organizationMemberships,
      and(
        eq(schema.organizationMemberships.organizationId, schema.knowledgeSpaces.organizationId),
        eq(schema.organizationMemberships.userId, schema.spaceMemberships.userId)
      )
    )
    .where(eq(schema.spaceMemberships.spaceId, spaceId))
    .orderBy(schema.spaceMemberships.createdAt);
}

export async function setSpaceMemberRole(input: {
  organizationId: string;
  spaceId: string;
  userId: string;
  role: Exclude<Role, "owner">;
  actorUserId: string;
}) {
  const db = getDatabase();
  const [organizationMember] = await db
    .select({ id: schema.organizationMemberships.userId })
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, input.organizationId),
        eq(schema.organizationMemberships.userId, input.userId),
        eq(schema.organizationMemberships.disabled, false)
      )
    )
    .limit(1);
  if (!organizationMember) throw new Error("SPACE_MEMBER_ORGANIZATION_REQUIRED");
  const [existing] = await db
    .select({ role: schema.spaceMemberships.role })
    .from(schema.spaceMemberships)
    .where(
      and(
        eq(schema.spaceMemberships.spaceId, input.spaceId),
        eq(schema.spaceMemberships.userId, input.userId)
      )
    )
    .limit(1);
  if (existing?.role === "owner") throw new Error("SPACE_OWNER_MUTATION_FORBIDDEN");
  await db
    .insert(schema.spaceMemberships)
    .values({ spaceId: input.spaceId, userId: input.userId, role: input.role })
    .onConflictDoUpdate({
      target: [schema.spaceMemberships.spaceId, schema.spaceMemberships.userId],
      set: { role: input.role }
    });
  await db.insert(schema.auditEvents).values({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: existing ? "space.member.role_updated" : "space.member.added",
    targetType: "space_membership",
    targetId: `${input.spaceId}:${input.userId}`,
    metadata: { spaceId: input.spaceId, role: input.role }
  });
}

export async function removeSpaceMember(input: {
  organizationId: string;
  spaceId: string;
  userId: string;
  actorUserId: string;
}) {
  const db = getDatabase();
  const [existing] = await db
    .select({ role: schema.spaceMemberships.role })
    .from(schema.spaceMemberships)
    .where(
      and(
        eq(schema.spaceMemberships.spaceId, input.spaceId),
        eq(schema.spaceMemberships.userId, input.userId)
      )
    )
    .limit(1);
  if (!existing) throw new Error("SPACE_MEMBER_NOT_FOUND");
  if (existing.role === "owner") throw new Error("SPACE_OWNER_MUTATION_FORBIDDEN");
  await db
    .delete(schema.spaceMemberships)
    .where(
      and(
        eq(schema.spaceMemberships.spaceId, input.spaceId),
        eq(schema.spaceMemberships.userId, input.userId)
      )
    );
  await db.insert(schema.auditEvents).values({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: "space.member.removed",
    targetType: "space_membership",
    targetId: `${input.spaceId}:${input.userId}`,
    metadata: { spaceId: input.spaceId }
  });
}

export interface UploadInput {
  spaceId: string;
  userId: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  compileProfile: WikiCompileProfile;
  allowAudioAsr?: boolean;
}

export const DIRECT_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const CHUNKED_UPLOAD_PART_BYTES = 4 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const CHUNKED_UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1_000;
const MAX_OFFICE_ZIP_ENTRIES = 5_000;
const MAX_OFFICE_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_OFFICE_COMPRESSION_RATIO = 100;

type UploadAdmissionKind = "text" | "pdf" | "office" | "image" | "audio" | "video";

const UPLOAD_TYPE_BY_EXTENSION = new Map<
  string,
  { mimeTypes: readonly string[]; kind: UploadAdmissionKind }
>([
  [".txt", { mimeTypes: ["text/plain"], kind: "text" }],
  [".md", { mimeTypes: ["text/markdown"], kind: "text" }],
  [".markdown", { mimeTypes: ["text/markdown"], kind: "text" }],
  [".csv", { mimeTypes: ["text/csv"], kind: "text" }],
  [".pdf", { mimeTypes: ["application/pdf"], kind: "pdf" }],
  [".png", { mimeTypes: ["image/png"], kind: "image" }],
  [".jpg", { mimeTypes: ["image/jpeg"], kind: "image" }],
  [".jpeg", { mimeTypes: ["image/jpeg"], kind: "image" }],
  [".webp", { mimeTypes: ["image/webp"], kind: "image" }],
  [".wav", { mimeTypes: ["audio/wav"], kind: "audio" }],
  [".mp3", { mimeTypes: ["audio/mpeg"], kind: "audio" }],
  [".m4a", { mimeTypes: ["audio/mp4", "audio/x-m4a"], kind: "audio" }],
  [".mp4", { mimeTypes: ["video/mp4"], kind: "video" }],
  [
    ".docx",
    {
      mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      kind: "office"
    }
  ],
  [
    ".pptx",
    {
      mimeTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      kind: "office"
    }
  ],
  [
    ".xlsx",
    {
      mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      kind: "office"
    }
  ]
]);

function validUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function unsafeOfficeArchive(): never {
  throw new Error("UPLOAD_ARCHIVE_UNSAFE");
}

function readZipUint16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) unsafeOfficeArchive();
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readZipUint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) unsafeOfficeArchive();
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function zipSignatureAt(bytes: Uint8Array, offset: number, signature: number): boolean {
  return readZipUint32(bytes, offset) === signature;
}

function expectedOfficePrimaryDocument(extension: string): string {
  if (extension === ".docx") return "word/document.xml";
  if (extension === ".pptx") return "ppt/presentation.xml";
  if (extension === ".xlsx") return "xl/workbook.xml";
  unsafeOfficeArchive();
}

/**
 * Reads only the ZIP central directory. It never expands user bytes: extraction
 * stays with the parser runtime after this admission check has bounded the
 * archive's declared footprint and rejected unsafe Office package features.
 */
function validateOfficeZipArchive(bytes: Uint8Array, extension: string): void {
  const eocdMinimumOffset = Math.max(0, bytes.byteLength - 0xffff - 22);
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= eocdMinimumOffset; offset -= 1) {
    if (!zipSignatureAt(bytes, offset, 0x06054b50)) continue;
    const commentLength = readZipUint16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.byteLength) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) unsafeOfficeArchive();

  const diskNumber = readZipUint16(bytes, eocdOffset + 4);
  const centralDirectoryDisk = readZipUint16(bytes, eocdOffset + 6);
  const entriesOnDisk = readZipUint16(bytes, eocdOffset + 8);
  const entries = readZipUint16(bytes, eocdOffset + 10);
  const directorySize = readZipUint32(bytes, eocdOffset + 12);
  const directoryOffset = readZipUint32(bytes, eocdOffset + 16);
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entries !== entriesOnDisk ||
    entries === 0 ||
    entries > MAX_OFFICE_ZIP_ENTRIES ||
    directoryOffset + directorySize > eocdOffset
  )
    unsafeOfficeArchive();

  const primaryDocument = expectedOfficePrimaryDocument(extension);
  const names = new Set<string>();
  let cursor = directoryOffset;
  let totalUncompressedBytes = 0;
  let totalCompressedBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (!zipSignatureAt(bytes, cursor, 0x02014b50)) unsafeOfficeArchive();
    const flags = readZipUint16(bytes, cursor + 8);
    const compressionMethod = readZipUint16(bytes, cursor + 10);
    const compressedSize = readZipUint32(bytes, cursor + 20);
    const uncompressedSize = readZipUint32(bytes, cursor + 24);
    const nameLength = readZipUint16(bytes, cursor + 28);
    const extraLength = readZipUint16(bytes, cursor + 30);
    const commentLength = readZipUint16(bytes, cursor + 32);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (cursor + recordLength > directoryOffset + directorySize) unsafeOfficeArchive();
    if ((flags & 0x1) !== 0 || ![0, 8].includes(compressionMethod)) unsafeOfficeArchive();

    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(cursor + 46, cursor + 46 + nameLength)
      );
    } catch {
      unsafeOfficeArchive();
    }
    const isDirectory = name.endsWith("/");
    const segments = (isDirectory ? name.slice(0, -1) : name).split("/");
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      segments.some((segment) => !segment || segment === "." || segment === "..") ||
      names.has(name)
    )
      unsafeOfficeArchive();
    names.add(name);
    if (name.toLowerCase().endsWith("/vbaproject.bin") || name.toLowerCase() === "vbaproject.bin")
      unsafeOfficeArchive();
    if (uncompressedSize > 0 && compressedSize === 0) unsafeOfficeArchive();
    if (
      uncompressedSize > 0 &&
      uncompressedSize / Math.max(compressedSize, 1) > MAX_OFFICE_COMPRESSION_RATIO
    )
      unsafeOfficeArchive();
    totalUncompressedBytes += uncompressedSize;
    totalCompressedBytes += compressedSize;
    if (totalUncompressedBytes > MAX_OFFICE_UNCOMPRESSED_BYTES) unsafeOfficeArchive();
    cursor += recordLength;
  }
  if (
    cursor !== directoryOffset + directorySize ||
    !names.has(primaryDocument) ||
    (totalUncompressedBytes > 0 &&
      totalUncompressedBytes / Math.max(totalCompressedBytes, 1) > MAX_OFFICE_COMPRESSION_RATIO)
  )
    unsafeOfficeArchive();
}

function validateUploadMetadata(input: Pick<UploadInput, "name" | "mimeType">): string {
  const containsControlCharacter = [...input.name].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    input.name.length === 0 ||
    [...input.name].length > 255 ||
    input.name.trim() !== input.name ||
    /[\\/]/.test(input.name) ||
    containsControlCharacter
  )
    throw new Error("UPLOAD_NAME_INVALID");
  const extension = path.extname(input.name).toLowerCase();
  const admission = UPLOAD_TYPE_BY_EXTENSION.get(extension);
  if (!admission) throw new Error("UPLOAD_MIME_UNSUPPORTED");
  if (!admission.mimeTypes.includes(input.mimeType)) throw new Error("UPLOAD_MIME_MISMATCH");
  return extension;
}

/**
 * Validates untrusted upload metadata and bytes without opening BlobStore,
 * the database, or the job queue. ZIP contents are never expanded here;
 * parser-specific semantic checks stay downstream.
 */
export function validateUploadInput(
  input: Pick<UploadInput, "name" | "mimeType" | "bytes" | "allowAudioAsr">
): string {
  const extension = validateUploadMetadata(input);
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_UPLOAD_BYTES)
    throw new Error("UPLOAD_SIZE_INVALID");
  const admission = UPLOAD_TYPE_BY_EXTENSION.get(extension);
  if (!admission) throw new Error("UPLOAD_MIME_UNSUPPORTED");
  if (admission.kind === "audio" && !input.allowAudioAsr)
    throw new Error("UPLOAD_MIME_UNSUPPORTED");

  const signatureMatches =
    admission.kind === "text"
      ? validUtf8Text(input.bytes)
      : admission.kind === "pdf"
        ? startsWith(input.bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
        : admission.kind === "image"
          ? (extension === ".png" &&
              startsWith(input.bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
            ((extension === ".jpg" || extension === ".jpeg") &&
              startsWith(input.bytes, [0xff, 0xd8, 0xff])) ||
            (extension === ".webp" &&
              startsWith(input.bytes, [0x52, 0x49, 0x46, 0x46]) &&
              input.bytes.length >= 12 &&
              new TextDecoder("ascii").decode(input.bytes.subarray(8, 12)) === "WEBP")
          : admission.kind === "audio"
            ? (extension === ".wav" &&
                startsWith(input.bytes, [0x52, 0x49, 0x46, 0x46]) &&
                input.bytes.length >= 12 &&
                new TextDecoder("ascii").decode(input.bytes.subarray(8, 12)) === "WAVE") ||
              (extension === ".mp3" &&
                (startsWith(input.bytes, [0x49, 0x44, 0x33]) ||
                  (input.bytes.length >= 2 &&
                    input.bytes[0] === 0xff &&
                    ((input.bytes[1] ?? 0) & 0xe0) === 0xe0))) ||
              (extension === ".m4a" &&
                input.bytes.length >= 12 &&
                new TextDecoder("ascii").decode(input.bytes.subarray(4, 8)) === "ftyp")
            : admission.kind === "video"
              ? input.bytes.length >= 12 &&
                new TextDecoder("ascii").decode(input.bytes.subarray(4, 8)) === "ftyp"
              : startsWith(input.bytes, [0x50, 0x4b, 0x03, 0x04]);
  if (!signatureMatches) throw new Error("UPLOAD_MIME_MISMATCH");
  if (admission.kind === "office") validateOfficeZipArchive(input.bytes, extension);
  return extension;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

async function findDuplicateResourceVersion(input: {
  spaceId: string;
  sha256: string;
  compileProfile: WikiCompileProfile;
}) {
  return getDatabase()
    .select({ version: schema.resourceVersions, resource: schema.resources })
    .from(schema.resourceVersions)
    .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
    .where(
      and(
        eq(schema.resources.spaceId, input.spaceId),
        eq(schema.resourceVersions.sha256, input.sha256),
        eq(schema.resourceVersions.compileProfile, input.compileProfile)
      )
    )
    .limit(1);
}

async function persistUploadedResource(input: {
  upload: UploadInput;
  sha256: string;
  blobUri: string;
  queue: Pick<JobQueue, "publish">;
  uploadId?: string;
  storageReservationId?: string | null;
  resourceId?: string;
  versionId?: string;
}) {
  const db = getDatabase();
  const resourceId = input.resourceId ?? randomUUID();
  const versionId = input.versionId ?? randomUUID();
  const jobId = randomUUID();
  const result = await db.transaction(async (tx) => {
    if (input.uploadId) {
      const [session] = await tx
        .select()
        .from(schema.resourceUploads)
        .where(eq(schema.resourceUploads.id, input.uploadId))
        .for("update")
        .limit(1);
      if (!session || session.userId !== input.upload.userId) throw new Error("UPLOAD_NOT_FOUND");
      if (session.status === "completed") return { existingUpload: session };
      if (session.status !== "finalizing") throw new Error("UPLOAD_NOT_OPEN");
      if (session.expiresAt <= new Date()) {
        await tx
          .update(schema.resourceUploads)
          .set({ status: "expired", updatedAt: new Date() })
          .where(eq(schema.resourceUploads.id, session.id));
        if (session.storageReservationId)
          await tx
            .delete(schema.storageReservations)
            .where(eq(schema.storageReservations.id, session.storageReservationId));
        throw new Error("UPLOAD_EXPIRED");
      }
    }
    const [resource] = await tx
      .insert(schema.resources)
      .values({
        id: resourceId,
        spaceId: input.upload.spaceId,
        name: input.upload.name,
        createdBy: input.upload.userId,
        status: "queued"
      })
      .returning();
    const [version] = await tx
      .insert(schema.resourceVersions)
      .values({
        id: versionId,
        resourceId,
        version: 1,
        originalName: input.upload.name,
        mimeType: input.upload.mimeType,
        byteSize: input.upload.bytes.byteLength,
        sha256: input.sha256,
        blobUri: input.blobUri,
        compileProfile: input.upload.compileProfile,
        createdBy: input.upload.userId
      })
      .returning();
    const [job] = await tx
      .insert(schema.processingJobs)
      .values({
        id: jobId,
        spaceId: input.upload.spaceId,
        resourceVersionId: versionId,
        kind: "resource.process"
      })
      .returning();
    await tx.insert(schema.jobOutbox).values({
      processingJobId: jobId,
      resourceVersionId: versionId,
      kind: "resource.process"
    });
    if (input.uploadId)
      await tx
        .update(schema.resourceUploads)
        .set({
          status: "completed",
          duplicate: false,
          resourceVersionId: versionId,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(schema.resourceUploads.id, input.uploadId),
            eq(schema.resourceUploads.status, "finalizing")
          )
        );
    if (input.storageReservationId)
      await tx
        .delete(schema.storageReservations)
        .where(eq(schema.storageReservations.id, input.storageReservationId));
    return { resource, version, job };
  });
  if ("existingUpload" in result) return completedChunkedUploadResult(result.existingUpload);
  await dispatchPendingProcessingOutbox(input.queue, 1, DEFAULT_OUTBOX_DISPATCH_LEASE_MS, jobId);
  return { duplicate: false, ...result };
}

export interface CreateChunkedUploadInput {
  spaceId: string;
  userId: string;
  name: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  compileProfile: WikiCompileProfile;
  allowAudioAsr?: boolean;
}

export async function createChunkedUploadSession(
  input: CreateChunkedUploadInput,
  options: { assertWriteCapacity?: (byteSize: number) => Promise<void> } = {}
) {
  const extension = validateUploadMetadata(input);
  const admission = UPLOAD_TYPE_BY_EXTENSION.get(extension);
  if (!admission) throw new Error("UPLOAD_MIME_UNSUPPORTED");
  if (admission.kind === "audio" && !input.allowAudioAsr) throw new Error("ASR_PROVIDER_REQUIRED");
  if (!Number.isInteger(input.byteSize) || input.byteSize <= DIRECT_UPLOAD_MAX_BYTES)
    throw new Error("UPLOAD_SESSION_INVALID");
  if (input.byteSize > MAX_UPLOAD_BYTES) throw new Error("UPLOAD_SIZE_INVALID");
  if (!validSha256(input.sha256)) throw new Error("UPLOAD_SESSION_INVALID");
  const partSize = CHUNKED_UPLOAD_PART_BYTES;
  const totalParts = Math.ceil(input.byteSize / partSize);
  const uploadId = randomUUID();
  const expiresAt = new Date(Date.now() + CHUNKED_UPLOAD_EXPIRY_MS);
  await options.assertWriteCapacity?.(input.byteSize);
  const storageReservationId = await reserveStorage({
    organizationId: await organizationIdForSpace(input.spaceId),
    byteSize: input.byteSize,
    expiresAt
  });
  try {
    await getDatabase().insert(schema.resourceUploads).values({
      id: uploadId,
      spaceId: input.spaceId,
      userId: input.userId,
      originalName: input.name,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      compileProfile: input.compileProfile,
      partSize,
      totalParts,
      storageReservationId,
      expiresAt
    });
  } catch (error) {
    await releaseStorageReservation(storageReservationId);
    throw error;
  }
  return { uploadId, partSize, totalParts, receivedParts: [], expiresAt };
}

async function ownedUploadSession(uploadId: string, userId: string) {
  const db = getDatabase();
  const [upload] = await db
    .select()
    .from(schema.resourceUploads)
    .where(and(eq(schema.resourceUploads.id, uploadId), eq(schema.resourceUploads.userId, userId)))
    .limit(1);
  if (!upload) throw new Error("UPLOAD_NOT_FOUND");
  if (
    (upload.status === "open" || upload.status === "finalizing") &&
    upload.expiresAt <= new Date()
  ) {
    await db
      .update(schema.resourceUploads)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(schema.resourceUploads.id, uploadId));
    await releaseStorageReservation(upload.storageReservationId);
    throw new Error("UPLOAD_EXPIRED");
  }
  return upload;
}

export async function getChunkedUploadSession(uploadId: string, userId: string) {
  const upload = await ownedUploadSession(uploadId, userId);
  const parts = await getDatabase()
    .select({ partNumber: schema.resourceUploadParts.partNumber })
    .from(schema.resourceUploadParts)
    .where(eq(schema.resourceUploadParts.uploadId, uploadId))
    .orderBy(asc(schema.resourceUploadParts.partNumber));
  return { upload, receivedParts: parts.map((part) => part.partNumber) };
}

export interface ExpiredChunkedUploadCleanupSummary {
  sessionsExpired: number;
  partsDeleted: number;
  partDeleteFailures: number;
}

export async function markChunkedUploadFinalizationFailure(input: {
  uploadId: string;
  jobId: string;
  errorCode: string;
  errorMessage: string;
  terminal: boolean;
}): Promise<{ terminal: boolean; settled: boolean }> {
  return getDatabase().transaction(async (tx) => {
    const [upload] = await tx
      .select()
      .from(schema.resourceUploads)
      .where(eq(schema.resourceUploads.id, input.uploadId))
      .for("update")
      .limit(1);
    if (!upload) return { terminal: input.terminal, settled: false };
    const [job] = await tx
      .select({ status: schema.processingJobs.status })
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, input.jobId))
      .for("update")
      .limit(1);
    if (!job || job.status === "completed" || job.status === "failed")
      return { terminal: input.terminal, settled: false };
    if (!input.terminal && upload.status !== "finalizing")
      return { terminal: input.terminal, settled: false };
    const now = new Date();
    await tx
      .update(schema.processingJobs)
      .set({
        status: input.terminal ? "failed" : "queued",
        stage: input.terminal ? "failed" : "retry_wait",
        errorCode: input.errorCode,
        errorMessage: input.errorMessage.slice(0, 2_000),
        finishedAt: input.terminal ? now : null,
        updatedAt: now
      })
      .where(eq(schema.processingJobs.id, input.jobId));
    if (!input.terminal) return { terminal: input.terminal, settled: true };
    if (upload.status === "finalizing")
      await tx
        .update(schema.resourceUploads)
        .set({
          status: "failed",
          errorCode: input.errorCode,
          errorMessage: input.errorMessage.slice(0, 2_000),
          updatedAt: now
        })
        .where(eq(schema.resourceUploads.id, upload.id));
    if (upload.storageReservationId)
      await tx
        .delete(schema.storageReservations)
        .where(eq(schema.storageReservations.id, upload.storageReservationId));
    return { terminal: input.terminal, settled: true };
  });
}

export async function cleanupExpiredChunkedUploads(
  blobStore: Pick<BlobStore, "removeTemporary">,
  options: { limit?: number; now?: Date } = {}
): Promise<ExpiredChunkedUploadCleanupSummary> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
    throw new Error("UPLOAD_CLEANUP_LIMIT_INVALID");
  const now = options.now ?? new Date();
  const db = getDatabase();
  const candidates = await db
    .select({ id: schema.resourceUploads.id })
    .from(schema.resourceUploads)
    .where(
      and(
        inArray(schema.resourceUploads.status, ["open", "failed", "expired"]),
        lte(schema.resourceUploads.expiresAt, now)
      )
    )
    .orderBy(asc(schema.resourceUploads.expiresAt))
    .limit(limit);
  let sessionsExpired = 0;
  let partsDeleted = 0;
  let partDeleteFailures = 0;

  for (const candidate of candidates) {
    const claimed = await db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(schema.resourceUploads)
        .where(eq(schema.resourceUploads.id, candidate.id))
        .for("update")
        .limit(1);
      if (
        !session ||
        session.expiresAt > now ||
        (session.status !== "open" && session.status !== "failed" && session.status !== "expired")
      )
        return null;
      if (session.status === "open") {
        await tx
          .update(schema.resourceUploads)
          .set({ status: "expired", updatedAt: now })
          .where(eq(schema.resourceUploads.id, session.id));
        sessionsExpired += 1;
      }
      if (session.storageReservationId)
        await tx
          .delete(schema.storageReservations)
          .where(eq(schema.storageReservations.id, session.storageReservationId));
      const parts = await tx
        .select({ blobUri: schema.resourceUploadParts.blobUri })
        .from(schema.resourceUploadParts)
        .where(eq(schema.resourceUploadParts.uploadId, session.id));
      return { uploadId: session.id, parts };
    });
    if (!claimed) continue;

    for (const part of claimed.parts) {
      try {
        await blobStore.removeTemporary(part.blobUri);
        await db
          .delete(schema.resourceUploadParts)
          .where(
            and(
              eq(schema.resourceUploadParts.uploadId, claimed.uploadId),
              eq(schema.resourceUploadParts.blobUri, part.blobUri)
            )
          );
        partsDeleted += 1;
      } catch {
        partDeleteFailures += 1;
      }
    }
  }
  return { sessionsExpired, partsDeleted, partDeleteFailures };
}

function expectedPartByteSize(
  upload: typeof schema.resourceUploads.$inferSelect,
  partNumber: number
) {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > upload.totalParts)
    throw new Error("UPLOAD_PART_RANGE_INVALID");
  if (partNumber < upload.totalParts) return upload.partSize;
  return upload.byteSize - upload.partSize * (upload.totalParts - 1);
}

export async function putChunkedUploadPart(input: {
  uploadId: string;
  userId: string;
  partNumber: number;
  bytes: Uint8Array;
  blobStore: BlobStore;
}) {
  const upload = await ownedUploadSession(input.uploadId, input.userId);
  if (upload.status !== "open") throw new Error("UPLOAD_NOT_OPEN");
  if (input.bytes.byteLength !== expectedPartByteSize(upload, input.partNumber))
    throw new Error("UPLOAD_PART_SIZE_INVALID");
  const sha256 = sha256Hex(input.bytes);
  const db = getDatabase();
  const [existing] = await db
    .select()
    .from(schema.resourceUploadParts)
    .where(
      and(
        eq(schema.resourceUploadParts.uploadId, input.uploadId),
        eq(schema.resourceUploadParts.partNumber, input.partNumber)
      )
    )
    .limit(1);
  if (existing) {
    if (existing.sha256 !== sha256 || existing.byteSize !== input.bytes.byteLength)
      throw new Error("UPLOAD_PART_CONFLICT");
    const session = await getChunkedUploadSession(input.uploadId, input.userId);
    return { duplicate: true, receivedParts: session.receivedParts, totalParts: upload.totalParts };
  }
  const blobUri = await input.blobStore.putTemporary(
    `${upload.spaceId}/${input.uploadId}/parts/${input.partNumber}`,
    input.bytes
  );
  try {
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          status: schema.resourceUploads.status,
          expiresAt: schema.resourceUploads.expiresAt
        })
        .from(schema.resourceUploads)
        .where(eq(schema.resourceUploads.id, input.uploadId))
        .for("update")
        .limit(1);
      if (!current || current.status !== "open") throw new Error("UPLOAD_NOT_OPEN");
      if (current.expiresAt <= new Date()) throw new Error("UPLOAD_EXPIRED");
      await tx.insert(schema.resourceUploadParts).values({
        uploadId: input.uploadId,
        partNumber: input.partNumber,
        byteSize: input.bytes.byteLength,
        sha256,
        blobUri
      });
    });
  } catch (error) {
    await input.blobStore.removeTemporary(blobUri).catch(() => undefined);
    throw error;
  }
  const session = await getChunkedUploadSession(input.uploadId, input.userId);
  return { duplicate: false, receivedParts: session.receivedParts, totalParts: upload.totalParts };
}

async function completedChunkedUploadResult(upload: typeof schema.resourceUploads.$inferSelect) {
  if (!upload.resourceVersionId) throw new Error("UPLOAD_COMPLETION_STATE_INVALID");
  const db = getDatabase();
  const [row] = await db
    .select({ version: schema.resourceVersions, resource: schema.resources })
    .from(schema.resourceVersions)
    .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
    .where(eq(schema.resourceVersions.id, upload.resourceVersionId))
    .limit(1);
  if (!row) throw new Error("UPLOAD_COMPLETION_STATE_INVALID");
  const [job] = upload.duplicate
    ? []
    : await db
        .select()
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.resourceVersionId, upload.resourceVersionId))
        .orderBy(desc(schema.processingJobs.createdAt))
        .limit(1);
  return {
    duplicate: upload.duplicate,
    resource: row.resource,
    version: row.version,
    job: job ?? null
  };
}

export async function requestChunkedUploadFinalization(input: {
  uploadId: string;
  userId: string;
  sha256: string;
}) {
  const upload = await ownedUploadSession(input.uploadId, input.userId);
  if (!validSha256(input.sha256) || input.sha256 !== upload.sha256)
    throw new Error("UPLOAD_HASH_MISMATCH");
  if (upload.status === "completed") return completedChunkedUploadResult(upload);
  if (upload.status === "finalizing")
    return { duplicate: false, resource: null, version: null, job: null };
  if (upload.status !== "open") throw new Error("UPLOAD_NOT_OPEN");
  const db = getDatabase();
  const parts = await db
    .select({ partNumber: schema.resourceUploadParts.partNumber })
    .from(schema.resourceUploadParts)
    .where(eq(schema.resourceUploadParts.uploadId, input.uploadId));
  if (
    parts.length !== upload.totalParts ||
    new Set(parts.map((part) => part.partNumber)).size !== upload.totalParts
  )
    throw new Error("UPLOAD_INCOMPLETE");
  const jobId = randomUUID();
  const [job] = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(schema.resourceUploads)
      .set({ status: "finalizing", updatedAt: new Date() })
      .where(
        and(
          eq(schema.resourceUploads.id, upload.id),
          eq(schema.resourceUploads.status, "open"),
          gt(schema.resourceUploads.expiresAt, new Date())
        )
      )
      .returning();
    if (!claimed) throw new Error("UPLOAD_NOT_OPEN");
    const jobs = await tx
      .insert(schema.processingJobs)
      .values({
        id: jobId,
        spaceId: upload.spaceId,
        kind: "resource.upload.finalize",
        stage: "upload_finalize"
      })
      .returning();
    await tx.insert(schema.jobOutbox).values({
      processingJobId: jobId,
      kind: "resource.upload.finalize",
      uploadId: upload.id
    });
    return jobs;
  });
  return { duplicate: false, resource: null, version: null, job: job ?? null };
}

export async function finalizeChunkedUpload(input: {
  uploadId: string;
  userId: string;
  blobStore: BlobStore;
  queue: Pick<JobQueue, "publish">;
  allowAudioAsr?: boolean;
}) {
  const upload = await ownedUploadSession(input.uploadId, input.userId);
  if (upload.status === "completed") return completedChunkedUploadResult(upload);
  if (upload.status !== "finalizing") throw new Error("UPLOAD_NOT_OPEN");
  const db = getDatabase();
  const parts = await db
    .select()
    .from(schema.resourceUploadParts)
    .where(eq(schema.resourceUploadParts.uploadId, input.uploadId))
    .orderBy(asc(schema.resourceUploadParts.partNumber));
  if (
    parts.length !== upload.totalParts ||
    parts.some((part, index) => part.partNumber !== index + 1)
  )
    throw new Error("UPLOAD_INCOMPLETE");
  const assembled = Buffer.concat(
    await Promise.all(parts.map((part) => input.blobStore.read(part.blobUri)))
  );
  if (assembled.byteLength !== upload.byteSize) throw new Error("UPLOAD_PART_SIZE_INVALID");
  if (sha256Hex(assembled) !== upload.sha256) throw new Error("UPLOAD_HASH_MISMATCH");
  const uploadInput: UploadInput = {
    spaceId: upload.spaceId,
    userId: upload.userId,
    name: upload.originalName,
    mimeType: upload.mimeType,
    bytes: assembled,
    compileProfile: upload.compileProfile,
    ...(input.allowAudioAsr ? { allowAudioAsr: true } : {})
  };
  const extension = validateUploadInput(uploadInput);
  const [duplicate] = await findDuplicateResourceVersion({
    spaceId: upload.spaceId,
    sha256: upload.sha256,
    compileProfile: upload.compileProfile
  });
  if (duplicate) {
    await db.transaction(async (tx) => {
      const [lockedUpload] = await tx
        .select()
        .from(schema.resourceUploads)
        .where(eq(schema.resourceUploads.id, upload.id))
        .for("update")
        .limit(1);
      if (!lockedUpload || lockedUpload.userId !== input.userId)
        throw new Error("UPLOAD_NOT_FOUND");
      if (lockedUpload.status !== "finalizing") throw new Error("UPLOAD_NOT_OPEN");
      if (lockedUpload.expiresAt <= new Date()) {
        await tx
          .update(schema.resourceUploads)
          .set({ status: "expired", updatedAt: new Date() })
          .where(eq(schema.resourceUploads.id, lockedUpload.id));
        if (lockedUpload.storageReservationId)
          await tx
            .delete(schema.storageReservations)
            .where(eq(schema.storageReservations.id, lockedUpload.storageReservationId));
        throw new Error("UPLOAD_EXPIRED");
      }
      await tx
        .update(schema.resourceUploads)
        .set({
          status: "completed",
          duplicate: true,
          resourceVersionId: duplicate.version.id,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(schema.resourceUploads.id, upload.id),
            eq(schema.resourceUploads.status, "finalizing")
          )
        );
      if (lockedUpload.storageReservationId)
        await tx
          .delete(schema.storageReservations)
          .where(eq(schema.storageReservations.id, lockedUpload.storageReservationId));
    });
    await Promise.all(parts.map((part) => input.blobStore.removeTemporary(part.blobUri)));
    return { duplicate: true, resource: duplicate.resource, version: duplicate.version, job: null };
  }
  const resourceId = randomUUID();
  const versionId = randomUUID();
  const blobUri = await input.blobStore.composeTemporary(
    parts.map((part) => part.blobUri),
    `${upload.spaceId}/${resourceId}/${versionId}/source${extension}`
  );
  const result = await persistUploadedResource({
    upload: uploadInput,
    sha256: upload.sha256,
    blobUri,
    queue: input.queue,
    uploadId: upload.id,
    storageReservationId: upload.storageReservationId,
    resourceId,
    versionId
  });
  await Promise.all(parts.map((part) => input.blobStore.removeTemporary(part.blobUri)));
  return result;
}

export async function createSpace(input: {
  organizationId: string;
  userId: string;
  name: string;
  description: string;
  dataPolicy: DataPolicy;
  dataRoot: string;
}) {
  const db = getDatabase();
  const [space] = await db.transaction(async (tx) => {
    const created = await tx
      .insert(schema.knowledgeSpaces)
      .values({
        organizationId: input.organizationId,
        createdBy: input.userId,
        name: input.name,
        description: input.description,
        dataPolicy: input.dataPolicy
      })
      .returning();
    const value = created[0];
    if (!value) throw new Error("SPACE_CREATE_FAILED");
    await tx
      .insert(schema.spaceMemberships)
      .values({ spaceId: value.id, userId: input.userId, role: "owner" });
    await tx.insert(schema.auditEvents).values({
      organizationId: input.organizationId,
      actorUserId: input.userId,
      action: "space.created",
      targetType: "space",
      targetId: value.id
    });
    return [value];
  });
  if (!space) throw new Error("SPACE_CREATE_FAILED");
  await initializeSpace(input.dataRoot, space.id);
  return space;
}

export async function listSpaces(userId: string) {
  return getDatabase()
    .select({ space: schema.knowledgeSpaces, role: schema.spaceMemberships.role })
    .from(schema.spaceMemberships)
    .innerJoin(
      schema.knowledgeSpaces,
      eq(schema.spaceMemberships.spaceId, schema.knowledgeSpaces.id)
    )
    .innerJoin(
      schema.organizationMemberships,
      and(
        eq(schema.organizationMemberships.organizationId, schema.knowledgeSpaces.organizationId),
        eq(schema.organizationMemberships.userId, userId)
      )
    )
    .where(
      and(
        eq(schema.spaceMemberships.userId, userId),
        eq(schema.organizationMemberships.disabled, false)
      )
    )
    .orderBy(desc(schema.knowledgeSpaces.updatedAt));
}

export async function uploadResource(input: UploadInput, blobStore: BlobStore, queue: JobQueue) {
  const extension = validateUploadInput(input);
  const sha256 = sha256Hex(input.bytes);
  const [duplicate] = await findDuplicateResourceVersion({
    spaceId: input.spaceId,
    sha256,
    compileProfile: input.compileProfile
  });
  if (duplicate)
    return { duplicate: true, resource: duplicate.resource, version: duplicate.version, job: null };

  const resourceId = randomUUID();
  const versionId = randomUUID();
  const storageReservationId = await reserveStorage({
    organizationId: await organizationIdForSpace(input.spaceId),
    byteSize: input.bytes.byteLength,
    expiresAt: new Date(Date.now() + DIRECT_UPLOAD_RESERVATION_MS)
  });
  try {
    const blobUri = await blobStore.putImmutable(
      `${input.spaceId}/${resourceId}/${versionId}/source${extension}`,
      input.bytes
    );
    return await persistUploadedResource({
      upload: input,
      sha256,
      blobUri,
      queue,
      storageReservationId,
      resourceId,
      versionId
    });
  } catch (error) {
    await releaseStorageReservation(storageReservationId);
    throw error;
  }
}

export async function replaceResourceVersion(
  input: UploadInput & { resourceId: string },
  blobStore: BlobStore,
  queue: JobQueue
) {
  const extension = validateUploadInput(input);
  const sha256 = sha256Hex(input.bytes);
  const db = getDatabase();
  const [resource] = await db
    .select()
    .from(schema.resources)
    .where(eq(schema.resources.id, input.resourceId))
    .limit(1);
  if (!resource || resource.spaceId !== input.spaceId) throw new Error("RESOURCE_NOT_FOUND");

  const [duplicate] = await db
    .select({ version: schema.resourceVersions })
    .from(schema.resourceVersions)
    .where(
      and(
        eq(schema.resourceVersions.resourceId, resource.id),
        eq(schema.resourceVersions.sha256, sha256),
        eq(schema.resourceVersions.compileProfile, input.compileProfile)
      )
    )
    .limit(1);
  if (duplicate) return { duplicate: true, resource, version: duplicate.version, job: null };

  const versionId = randomUUID();
  const [reusable] = await findDuplicateResourceVersion({
    spaceId: input.spaceId,
    sha256,
    compileProfile: input.compileProfile
  });
  const reusedBlobUri =
    reusable && (await blobStore.exists(reusable.version.blobUri))
      ? reusable.version.blobUri
      : null;
  const storageReservationId = reusedBlobUri
    ? null
    : await reserveStorage({
        organizationId: await organizationIdForSpace(input.spaceId),
        byteSize: input.bytes.byteLength,
        expiresAt: new Date(Date.now() + DIRECT_UPLOAD_RESERVATION_MS)
      });
  let blobUri: string;
  try {
    blobUri =
      reusedBlobUri ??
      (await blobStore.putImmutable(
        `${input.spaceId}/${resource.id}/${versionId}/source${extension}`,
        input.bytes
      ));
  } catch (error) {
    await releaseStorageReservation(storageReservationId);
    throw error;
  }
  const jobId = randomUUID();
  let result: {
    resource: typeof schema.resources.$inferSelect;
    version: typeof schema.resourceVersions.$inferSelect;
    job: typeof schema.processingJobs.$inferSelect;
  };
  try {
    result = await db.transaction(async (tx) => {
      const [lockedResource] = await tx
        .select()
        .from(schema.resources)
        .where(eq(schema.resources.id, resource.id))
        .for("update")
        .limit(1);
      if (!lockedResource || lockedResource.spaceId !== input.spaceId)
        throw new Error("RESOURCE_NOT_FOUND");
      const [latest] = await tx
        .select({ version: schema.resourceVersions.version })
        .from(schema.resourceVersions)
        .where(eq(schema.resourceVersions.resourceId, resource.id))
        .orderBy(desc(schema.resourceVersions.version))
        .limit(1);
      const [version] = await tx
        .insert(schema.resourceVersions)
        .values({
          id: versionId,
          resourceId: resource.id,
          version: (latest?.version ?? 0) + 1,
          originalName: input.name,
          mimeType: input.mimeType,
          byteSize: input.bytes.byteLength,
          sha256,
          blobUri,
          compileProfile: input.compileProfile,
          createdBy: input.userId
        })
        .returning();
      const [job] = await tx
        .insert(schema.processingJobs)
        .values({
          id: jobId,
          spaceId: input.spaceId,
          resourceVersionId: versionId,
          kind: "resource.process"
        })
        .returning();
      await tx.insert(schema.jobOutbox).values({
        processingJobId: jobId,
        resourceVersionId: versionId,
        kind: "resource.process"
      });
      const [updatedResource] = await tx
        .update(schema.resources)
        .set({ name: input.name, status: "queued", updatedAt: new Date() })
        .where(eq(schema.resources.id, resource.id))
        .returning();
      if (!version || !job || !updatedResource) throw new Error("RESOURCE_VERSION_CREATE_FAILED");
      if (storageReservationId)
        await tx
          .delete(schema.storageReservations)
          .where(eq(schema.storageReservations.id, storageReservationId));
      return { resource: updatedResource, version, job };
    });
  } catch (error) {
    await releaseStorageReservation(storageReservationId);
    throw error;
  }
  await dispatchPendingProcessingOutbox(queue, 1, DEFAULT_OUTBOX_DISPATCH_LEASE_MS, jobId);
  return { duplicate: false, ...result };
}

export async function recompileResourceVersion(
  input: {
    resourceId: string;
    spaceId: string;
    userId: string;
    compileProfile: WikiCompileProfile;
  },
  queue: JobQueue
) {
  const db = getDatabase();
  const organizationId = await organizationIdForSpace(input.spaceId);
  const jobId = randomUUID();
  const result = await db.transaction(async (tx) => {
    const [resource] = await tx
      .select()
      .from(schema.resources)
      .where(eq(schema.resources.id, input.resourceId))
      .for("update")
      .limit(1);
    if (!resource || resource.spaceId !== input.spaceId) throw new Error("RESOURCE_NOT_FOUND");
    const [latest] = await tx
      .select()
      .from(schema.resourceVersions)
      .where(eq(schema.resourceVersions.resourceId, resource.id))
      .orderBy(desc(schema.resourceVersions.version))
      .limit(1);
    if (!latest) throw new Error("RESOURCE_VERSION_NOT_FOUND");
    const [duplicate] = await tx
      .select()
      .from(schema.resourceVersions)
      .where(
        and(
          eq(schema.resourceVersions.resourceId, resource.id),
          eq(schema.resourceVersions.sha256, latest.sha256),
          eq(schema.resourceVersions.compileProfile, input.compileProfile)
        )
      )
      .limit(1);
    if (duplicate) return { duplicate: true as const, resource, version: duplicate, job: null };

    const versionId = randomUUID();
    const [version] = await tx
      .insert(schema.resourceVersions)
      .values({
        id: versionId,
        resourceId: resource.id,
        version: latest.version + 1,
        originalName: latest.originalName,
        mimeType: latest.mimeType,
        byteSize: latest.byteSize,
        sha256: latest.sha256,
        blobUri: latest.blobUri,
        compileProfile: input.compileProfile,
        createdBy: input.userId
      })
      .returning();
    const [job] = await tx
      .insert(schema.processingJobs)
      .values({
        id: jobId,
        spaceId: input.spaceId,
        resourceVersionId: versionId,
        kind: "resource.process"
      })
      .returning();
    await tx.insert(schema.jobOutbox).values({
      processingJobId: jobId,
      resourceVersionId: versionId,
      kind: "resource.process"
    });
    const [updatedResource] = await tx
      .update(schema.resources)
      .set({ status: "queued", updatedAt: new Date() })
      .where(eq(schema.resources.id, resource.id))
      .returning();
    if (!version || !job || !updatedResource) throw new Error("RESOURCE_RECOMPILE_FAILED");
    await tx.insert(schema.auditEvents).values({
      organizationId,
      actorUserId: input.userId,
      action: "resource.recompiled",
      targetType: "resource_version",
      targetId: version.id,
      metadata: {
        resourceId: resource.id,
        fromVersionId: latest.id,
        fromCompileProfile: latest.compileProfile,
        toCompileProfile: input.compileProfile
      }
    });
    return { duplicate: false as const, resource: updatedResource, version, job };
  });
  if (!result.duplicate)
    await dispatchPendingProcessingOutbox(queue, 1, DEFAULT_OUTBOX_DISPATCH_LEASE_MS, jobId);
  return result;
}

export async function retryProcessingJob(
  input: { jobId: string; spaceId: string },
  queue: JobQueue
) {
  const db = getDatabase();
  const result = await db.transaction(async (tx) => {
    const [original] = await tx
      .select({
        job: schema.processingJobs,
        version: schema.resourceVersions,
        resource: schema.resources
      })
      .from(schema.processingJobs)
      .innerJoin(
        schema.resourceVersions,
        eq(schema.processingJobs.resourceVersionId, schema.resourceVersions.id)
      )
      .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
      .where(
        and(
          eq(schema.processingJobs.id, input.jobId),
          eq(schema.processingJobs.spaceId, input.spaceId)
        )
      )
      .limit(1);
    if (!original) throw new Error("JOB_NOT_FOUND");
    if (original.job.status !== "failed") throw new Error("JOB_NOT_RETRYABLE");
    const [active] = await tx
      .select({ id: schema.processingJobs.id })
      .from(schema.processingJobs)
      .where(
        and(
          eq(schema.processingJobs.resourceVersionId, original.version.id),
          inArray(schema.processingJobs.status, ["queued", "processing"])
        )
      )
      .limit(1);
    if (active) throw new Error("JOB_RETRY_ALREADY_ACTIVE");
    const [job] = await tx
      .insert(schema.processingJobs)
      .values({
        id: randomUUID(),
        spaceId: input.spaceId,
        resourceVersionId: original.version.id,
        kind: original.job.kind
      })
      .returning();
    if (!job) throw new Error("JOB_RETRY_CREATE_FAILED");
    await tx.insert(schema.jobOutbox).values({
      processingJobId: job.id,
      resourceVersionId: original.version.id
    });
    await tx
      .update(schema.resources)
      .set({ status: "queued", updatedAt: new Date() })
      .where(eq(schema.resources.id, original.resource.id));
    return { job, resource: original.resource, version: original.version };
  });
  await dispatchPendingProcessingOutbox(queue, 1);
  return result;
}

export async function cancelProcessingJob(
  input: { jobId: string; spaceId: string },
  queue: JobQueue
) {
  const db = getDatabase();
  const result = await db.transaction(async (tx) => {
    const [original] = await tx
      .select({
        job: schema.processingJobs,
        version: schema.resourceVersions,
        resource: schema.resources
      })
      .from(schema.processingJobs)
      .innerJoin(
        schema.resourceVersions,
        eq(schema.processingJobs.resourceVersionId, schema.resourceVersions.id)
      )
      .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
      .where(
        and(
          eq(schema.processingJobs.id, input.jobId),
          eq(schema.processingJobs.spaceId, input.spaceId)
        )
      )
      .limit(1);
    if (!original) throw new Error("JOB_NOT_FOUND");
    if (original.job.status !== "queued" && original.job.status !== "processing")
      throw new Error("JOB_NOT_CANCELLABLE");
    const isQueued = original.job.status === "queued";
    const [job] = await tx
      .update(schema.processingJobs)
      .set({
        status: isQueued ? "cancelled" : "cancel_requested",
        stage: isQueued ? "cancelled" : "cancel_requested",
        ...(isQueued ? { finishedAt: new Date() } : {}),
        updatedAt: new Date()
      })
      .where(eq(schema.processingJobs.id, original.job.id))
      .returning();
    if (!job) throw new Error("JOB_CANCEL_FAILED");
    if (isQueued) {
      await tx
        .update(schema.resources)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(schema.resources.id, original.resource.id));
    }
    return { job, resource: original.resource, queueJobId: original.job.queueJobId };
  });
  if (result.queueJobId)
    await queue.cancel("resource.process", result.queueJobId).catch(() => false);
  return result;
}

export async function resumeProcessingJob(
  input: { jobId: string; spaceId: string },
  queue: JobQueue
) {
  const db = getDatabase();
  const [original] = await db
    .select({
      job: schema.processingJobs,
      version: schema.resourceVersions,
      resource: schema.resources
    })
    .from(schema.processingJobs)
    .innerJoin(
      schema.resourceVersions,
      eq(schema.processingJobs.resourceVersionId, schema.resourceVersions.id)
    )
    .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
    .where(
      and(
        eq(schema.processingJobs.id, input.jobId),
        eq(schema.processingJobs.spaceId, input.spaceId)
      )
    )
    .limit(1);
  if (!original) throw new Error("JOB_NOT_FOUND");
  if (original.job.status !== "cancelled") throw new Error("JOB_NOT_RESUMABLE");
  const [active] = await db
    .select({ id: schema.processingJobs.id })
    .from(schema.processingJobs)
    .where(
      and(
        eq(schema.processingJobs.resourceVersionId, original.version.id),
        inArray(schema.processingJobs.status, ["queued", "processing", "cancel_requested"])
      )
    )
    .limit(1);
  if (active) throw new Error("JOB_RESUME_ALREADY_ACTIVE");

  const resumed = original.job.queueJobId
    ? await queue.resume("resource.process", original.job.queueJobId).catch(() => false)
    : false;

  const [job] = await db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.processingJobs)
      .set({
        status: "queued",
        stage: "queued",
        progress: 0,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(schema.processingJobs.id, original.job.id),
          eq(schema.processingJobs.status, "cancelled")
        )
      )
      .returning();
    if (!updated[0]) throw new Error("JOB_NOT_RESUMABLE");
    await tx
      .update(schema.resources)
      .set({ status: "queued", updatedAt: new Date() })
      .where(eq(schema.resources.id, original.resource.id));
    if (!resumed)
      await tx
        .insert(schema.jobOutbox)
        .values({
          processingJobId: original.job.id,
          resourceVersionId: original.version.id,
          status: "pending"
        })
        .onConflictDoUpdate({
          target: schema.jobOutbox.processingJobId,
          set: {
            status: "pending",
            dispatchToken: null,
            dispatchLeaseExpiresAt: null,
            queueJobId: null,
            sentAt: null,
            lastErrorCode: null,
            lastErrorAt: null,
            updatedAt: new Date()
          }
        });
    return updated;
  });
  if (!job) throw new Error("JOB_RESUME_FAILED");
  if (!resumed)
    await dispatchPendingProcessingOutbox(
      queue,
      1,
      DEFAULT_OUTBOX_DISPATCH_LEASE_MS,
      original.job.id
    );
  const [latestJob] = await db
    .select()
    .from(schema.processingJobs)
    .where(eq(schema.processingJobs.id, original.job.id));
  if (!latestJob) throw new Error("JOB_RESUME_FAILED");
  return { job: latestJob, resource: original.resource, version: original.version };
}
