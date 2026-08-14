import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { recoverExpiredProcessingJobs, type JobQueue } from "../src/index";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";

const test = process.env.DATABASE_URL ? it : it.skip;

class RecoveryQueue implements Pick<JobQueue, "publish"> {
  readonly published: Array<{ jobId: string; resourceVersionId: string }> = [];

  async publish(
    _name: "resource.process",
    payload: { jobId: string; resourceVersionId: string }
  ): Promise<string> {
    this.published.push(payload);
    return randomUUID();
  }
}

async function fixture(status: "processing" | "cancel_requested") {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const resourceId = randomUUID();
  const versionId = randomUUID();
  const jobId = randomUUID();
  await db.insert(schema.organizations).values({ id: organizationId, name: "恢复流程测试组织" });
  await db.insert(schema.users).values({
    id: userId,
    email: `recovery-${jobId}@example.com`,
    name: "恢复流程测试用户",
    passwordHash: "not-used"
  });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "恢复流程测试空间",
    createdBy: userId
  });
  await db.insert(schema.resources).values({
    id: resourceId,
    spaceId,
    name: "recover.md",
    status: "processing",
    createdBy: userId
  });
  await db.insert(schema.resourceVersions).values({
    id: versionId,
    resourceId,
    version: 1,
    originalName: "recover.md",
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
    stage: "parsing",
    executionToken: randomUUID(),
    executionLeaseExpiresAt: new Date(Date.now() - 1_000)
  });
  return { db, organizationId, resourceId, versionId, jobId };
}

afterAll(async () => closeDatabase());

describe("expired processing job recovery", () => {
  test("republishes expired processing work without changing its resource version", async () => {
    const value = await fixture("processing");
    const queue = new RecoveryQueue();
    try {
      await expect(recoverExpiredProcessingJobs(queue, { jobIds: [value.jobId] })).resolves.toEqual(
        {
          requeued: 1,
          cancelled: 0
        }
      );
      expect(queue.published).toEqual([{ jobId: value.jobId, resourceVersionId: value.versionId }]);
      const [job] = await value.db
        .select()
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.id, value.jobId));
      const [resource] = await value.db
        .select()
        .from(schema.resources)
        .where(eq(schema.resources.id, value.resourceId));
      expect(job).toMatchObject({
        id: value.jobId,
        resourceVersionId: value.versionId,
        status: "queued",
        executionToken: null,
        executionLeaseExpiresAt: null
      });
      expect(resource?.status).toBe("queued");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("settles an expired cancellation without publishing a new queue job", async () => {
    const value = await fixture("cancel_requested");
    const queue = new RecoveryQueue();
    try {
      await expect(recoverExpiredProcessingJobs(queue, { jobIds: [value.jobId] })).resolves.toEqual(
        {
          requeued: 0,
          cancelled: 1
        }
      );
      expect(queue.published).toEqual([]);
      const [job] = await value.db
        .select()
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.id, value.jobId));
      const [resource] = await value.db
        .select()
        .from(schema.resources)
        .where(eq(schema.resources.id, value.resourceId));
      expect(job?.status).toBe("cancelled");
      expect(resource?.status).toBe("cancelled");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });
});
