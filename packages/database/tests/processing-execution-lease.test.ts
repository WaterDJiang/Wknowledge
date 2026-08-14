import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  claimExpiredProcessingForRecovery,
  claimProcessingExecution,
  clearCancelledExpiredExecution,
  closeDatabase,
  getDatabase,
  listExpiredProcessingExecutions,
  refreshProcessingExecution,
  releaseRecoveredProcessingExecution,
  schema,
  updateProcessingExecutionStage
} from "../src/index";

const test = process.env.DATABASE_URL ? it : it.skip;

async function fixture(status: "queued" | "processing" | "cancel_requested" = "queued") {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const resourceId = randomUUID();
  const versionId = randomUUID();
  const jobId = randomUUID();
  await db.insert(schema.organizations).values({ id: organizationId, name: "执行租约测试组织" });
  await db.insert(schema.users).values({
    id: userId,
    email: `lease-${jobId}@example.com`,
    name: "执行租约测试用户",
    passwordHash: "not-used"
  });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "执行租约测试空间",
    createdBy: userId
  });
  await db.insert(schema.resources).values({
    id: resourceId,
    spaceId,
    name: "lease.md",
    status: status === "queued" ? "queued" : "processing",
    createdBy: userId
  });
  await db.insert(schema.resourceVersions).values({
    id: versionId,
    resourceId,
    version: 1,
    originalName: "lease.md",
    mimeType: "text/markdown",
    byteSize: 12,
    sha256: randomUUID().replaceAll("-", ""),
    blobUri: `local://tests/${versionId}/source.md`,
    createdBy: userId
  });
  await db.insert(schema.processingJobs).values({
    id: jobId,
    spaceId,
    resourceVersionId: versionId,
    kind: "resource.process",
    status,
    stage: status,
    ...(status === "queued"
      ? {}
      : { executionToken: randomUUID(), executionLeaseExpiresAt: new Date(Date.now() - 1_000) })
  });
  return { db, organizationId, resourceId, versionId, jobId };
}

afterAll(async () => closeDatabase());

describe("processing execution lease", () => {
  test("permits only the owner until expiry, then safely hands execution to a new token", async () => {
    const value = await fixture();
    const firstToken = randomUUID();
    const secondToken = randomUUID();
    try {
      expect(await claimProcessingExecution(value.jobId, firstToken, 60_000)).toBe(true);
      expect(await claimProcessingExecution(value.jobId, secondToken, 60_000)).toBe(false);
      expect(await updateProcessingExecutionStage(value.jobId, firstToken, "compiled", 50)).toBe(
        true
      );

      await value.db
        .update(schema.processingJobs)
        .set({ executionLeaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.processingJobs.id, value.jobId));
      expect(await claimProcessingExecution(value.jobId, secondToken, 60_000)).toBe(true);
      expect(await refreshProcessingExecution(value.jobId, firstToken)).toBe(false);
      expect(
        await updateProcessingExecutionStage(value.jobId, secondToken, "wiki_compile", 60)
      ).toBe(true);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("claims an expired worker execution for recovery and releases it with a new queue job", async () => {
    const value = await fixture("processing");
    const recoveryToken = randomUUID();
    const queueJobId = randomUUID();
    try {
      expect((await listExpiredProcessingExecutions()).map((item) => item.id)).toContain(
        value.jobId
      );
      expect(await claimExpiredProcessingForRecovery(value.jobId, recoveryToken)).toBe(true);
      expect(
        await releaseRecoveredProcessingExecution(value.jobId, recoveryToken, queueJobId)
      ).toBe(true);
      const [job] = await value.db
        .select()
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.id, value.jobId));
      expect(job).toMatchObject({
        status: "queued",
        stage: "queued",
        queueJobId,
        executionToken: null,
        executionLeaseExpiresAt: null
      });
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("never requeues an expired cancellation request", async () => {
    const value = await fixture("cancel_requested");
    try {
      expect(await clearCancelledExpiredExecution(value.jobId)).toBe(true);
      const [job] = await value.db
        .select()
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.id, value.jobId));
      expect(job).toMatchObject({
        status: "cancelled",
        stage: "cancelled",
        executionToken: null,
        executionLeaseExpiresAt: null
      });
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });
});
