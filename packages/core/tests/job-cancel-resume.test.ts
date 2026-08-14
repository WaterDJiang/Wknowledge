import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { cancelProcessingJob, resumeProcessingJob, type JobQueue } from "../src/index";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";

const enabled = Boolean(process.env.DATABASE_URL);
const test = enabled ? it : it.skip;

class ControlledQueue implements JobQueue {
  readonly cancelled: string[] = [];
  readonly resumed: string[] = [];
  readonly published: Array<{ jobId: string; resourceVersionId: string }> = [];

  constructor(private readonly resumeResult: boolean) {}

  async publish(
    _name: "resource.process",
    payload: { jobId: string; resourceVersionId: string }
  ): Promise<string> {
    this.published.push(payload);
    return randomUUID();
  }

  async cancel(_name: "resource.process", queueJobId: string): Promise<boolean> {
    this.cancelled.push(queueJobId);
    return true;
  }

  async resume(_name: "resource.process", queueJobId: string): Promise<boolean> {
    this.resumed.push(queueJobId);
    return this.resumeResult;
  }
}

async function insertFixture(status: "queued" | "processing" | "cancelled") {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const resourceId = randomUUID();
  const versionId = randomUUID();
  const jobId = randomUUID();
  const queueJobId = randomUUID();
  await db.insert(schema.organizations).values({ id: organizationId, name: "任务韧性测试组织" });
  await db.insert(schema.users).values({
    id: userId,
    email: `job-${jobId}@example.com`,
    name: "任务韧性测试用户",
    passwordHash: "not-used"
  });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "任务韧性测试空间",
    createdBy: userId
  });
  await db.insert(schema.resources).values({
    id: resourceId,
    spaceId,
    name: "取消恢复测试.md",
    createdBy: userId,
    status: status === "cancelled" ? "cancelled" : status
  });
  await db.insert(schema.resourceVersions).values({
    id: versionId,
    resourceId,
    version: 1,
    originalName: "取消恢复测试.md",
    mimeType: "text/markdown",
    byteSize: 12,
    sha256: randomUUID().replaceAll("-", ""),
    blobUri: `local://tests/${versionId}/source.md`,
    compileProfile: "knowledge",
    createdBy: userId
  });
  await db.insert(schema.processingJobs).values({
    id: jobId,
    spaceId,
    resourceVersionId: versionId,
    queueJobId,
    kind: "resource.process",
    status,
    stage: status,
    progress: status === "cancelled" ? 20 : 0,
    ...(status === "cancelled" ? { finishedAt: new Date() } : {})
  });
  return { db, organizationId, spaceId, resourceId, versionId, jobId, queueJobId };
}

afterAll(async () => closeDatabase());

describe("processing job cancel and resume", () => {
  test("cancels a queued job without replacing its source version, then resumes the same job", async () => {
    const fixture = await insertFixture("queued");
    try {
      const queue = new ControlledQueue(true);
      const cancelled = await cancelProcessingJob(
        { jobId: fixture.jobId, spaceId: fixture.spaceId },
        queue
      );
      expect(cancelled.job).toMatchObject({ id: fixture.jobId, status: "cancelled" });
      expect(queue.cancelled).toEqual([fixture.queueJobId]);

      const resumed = await resumeProcessingJob(
        { jobId: fixture.jobId, spaceId: fixture.spaceId },
        queue
      );
      expect(resumed.job).toMatchObject({
        id: fixture.jobId,
        resourceVersionId: fixture.versionId,
        status: "queued",
        queueJobId: fixture.queueJobId
      });
      expect(queue.resumed).toEqual([fixture.queueJobId]);
      expect(queue.published).toEqual([]);
      const [resource] = await fixture.db
        .select()
        .from(schema.resources)
        .where(eq(schema.resources.id, fixture.resourceId));
      expect(resource?.status).toBe("queued");
    } finally {
      await fixture.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, fixture.organizationId));
    }
  });

  test("republishes a cancelled job when its pg-boss entry is no longer available", async () => {
    const fixture = await insertFixture("cancelled");
    try {
      const queue = new ControlledQueue(false);
      const resumed = await resumeProcessingJob(
        { jobId: fixture.jobId, spaceId: fixture.spaceId },
        queue
      );
      expect(queue.resumed).toEqual([fixture.queueJobId]);
      expect(queue.published).toEqual([
        { jobId: fixture.jobId, resourceVersionId: fixture.versionId }
      ]);
      expect(resumed.job.queueJobId).not.toBe(fixture.queueJobId);
      const [active] = await fixture.db
        .select({ id: schema.processingJobs.id })
        .from(schema.processingJobs)
        .where(
          and(
            eq(schema.processingJobs.resourceVersionId, fixture.versionId),
            eq(schema.processingJobs.status, "queued")
          )
        );
      expect(active?.id).toBe(fixture.jobId);
    } finally {
      await fixture.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, fixture.organizationId));
    }
  });

  test("does not allow cancelling or resuming outside the task state machine", async () => {
    const fixture = await insertFixture("cancelled");
    try {
      const queue = new ControlledQueue(true);
      await expect(
        cancelProcessingJob({ jobId: fixture.jobId, spaceId: fixture.spaceId }, queue)
      ).rejects.toThrow("JOB_NOT_CANCELLABLE");
      await resumeProcessingJob({ jobId: fixture.jobId, spaceId: fixture.spaceId }, queue);
      await expect(
        resumeProcessingJob({ jobId: fixture.jobId, spaceId: fixture.spaceId }, queue)
      ).rejects.toThrow("JOB_NOT_RESUMABLE");
    } finally {
      await fixture.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, fixture.organizationId));
    }
  });
});
