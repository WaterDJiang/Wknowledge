import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import {
  readOrganizationResourceQueueHealth,
  retryOrganizationFailedProcessingJobs,
  type JobQueue
} from "../src/index";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";

const test = process.env.DATABASE_URL ? it : it.skip;

class RecordingQueue implements JobQueue {
  readonly published: Array<{ jobId: string; resourceVersionId: string }> = [];

  async publish(
    _name: "resource.process" | "resource.upload.finalize",
    payload: { jobId: string; resourceVersionId: string } | { jobId: string; uploadId: string }
  ) {
    if ("resourceVersionId" in payload) this.published.push(payload);
    return randomUUID();
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async resume(): Promise<boolean> {
    return false;
  }
}

async function createOrganizationJob(input: {
  organizationId: string;
  status: "queued" | "failed";
}) {
  const db = getDatabase();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const resourceId = randomUUID();
  const resourceVersionId = randomUUID();
  const jobId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    email: `queue-${userId}@example.com`,
    name: "队列测试用户",
    passwordHash: "not-used"
  });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId: input.organizationId,
    name: "队列测试空间",
    createdBy: userId
  });
  await db.insert(schema.resources).values({
    id: resourceId,
    spaceId,
    name: "队列测试资料",
    status: input.status === "failed" ? "failed" : "queued",
    createdBy: userId
  });
  await db.insert(schema.resourceVersions).values({
    id: resourceVersionId,
    resourceId,
    version: 1,
    originalName: "queue.txt",
    mimeType: "text/plain",
    byteSize: 1,
    sha256: randomUUID().replaceAll("-", ""),
    blobUri: `local://${spaceId}/raw/queue.txt`,
    createdBy: userId
  });
  await db.insert(schema.processingJobs).values({
    id: jobId,
    spaceId,
    resourceVersionId,
    kind: "resource.process",
    status: input.status,
    stage: input.status,
    progress: input.status === "failed" ? 100 : 0,
    ...(input.status === "failed" ? { finishedAt: new Date() } : {})
  });
  return { jobId, resourceVersionId };
}

afterAll(async () => closeDatabase());

describe("organization queue isolation", () => {
  test("reads and retries only the current organization's latest failed resource jobs", async () => {
    const db = getDatabase();
    const organizationA = randomUUID();
    const organizationB = randomUUID();
    await db.insert(schema.organizations).values([
      { id: organizationA, name: "队列组织 A" },
      { id: organizationB, name: "队列组织 B" }
    ]);
    try {
      const failedA = await createOrganizationJob({
        organizationId: organizationA,
        status: "failed"
      });
      await createOrganizationJob({ organizationId: organizationA, status: "queued" });
      const failedB = await createOrganizationJob({
        organizationId: organizationB,
        status: "failed"
      });

      const before = await readOrganizationResourceQueueHealth(organizationA);
      expect(before.processing).toMatchObject({ queuedCount: 1, failedCount: 1, totalCount: 2 });
      expect(before.jobs).toEqual([expect.objectContaining({ id: failedA.jobId })]);
      expect(JSON.stringify(before)).not.toContain(failedB.jobId);

      const queue = new RecordingQueue();
      await expect(
        retryOrganizationFailedProcessingJobs({ organizationId: organizationA, limit: 25 }, queue)
      ).resolves.toEqual({ moved: 1, skipped: 0 });
      expect(queue.published).toEqual([
        expect.objectContaining({ resourceVersionId: failedA.resourceVersionId })
      ]);

      const after = await readOrganizationResourceQueueHealth(organizationA);
      expect(after.processing).toMatchObject({ queuedCount: 2, failedCount: 0, totalCount: 2 });
      expect(after.jobs).toEqual([]);

      const otherOrganization = await readOrganizationResourceQueueHealth(organizationB);
      expect(otherOrganization.jobs).toEqual([expect.objectContaining({ id: failedB.jobId })]);
    } finally {
      await db
        .delete(schema.organizations)
        .where(inArray(schema.organizations.id, [organizationA, organizationB]));
    }
  });
});
