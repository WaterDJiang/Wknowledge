import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import type { BlobStore } from "@wknowledge/blob-store";
import {
  dispatchPendingProcessingOutbox,
  uploadResource,
  type JobQueue,
  type ProcessingOutboxQueue
} from "../src/index";

const test = process.env.DATABASE_URL ? it : it.skip;

class ControlledQueue implements ProcessingOutboxQueue {
  readonly published: Array<{ jobId: string; resourceVersionId: string }> = [];

  constructor(private readonly fail: boolean) {}

  async publish(
    _name: "resource.process",
    payload: { jobId: string; resourceVersionId: string }
  ): Promise<string> {
    this.published.push(payload);
    if (this.fail) throw new Error("queue unavailable");
    return randomUUID();
  }
}

class UnavailableUploadQueue extends ControlledQueue implements JobQueue {
  async cancel(): Promise<boolean> {
    return false;
  }

  async resume(): Promise<boolean> {
    return false;
  }
}

class MemoryBlobStore implements BlobStore {
  async putImmutable(key: string): Promise<string> {
    return `local://${key}`;
  }

  async putTemporary(key: string): Promise<string> {
    return `local://.temporary/${key}`;
  }

  async composeTemporary(_parts: readonly string[], immutableKey: string): Promise<string> {
    return `local://${immutableKey}`;
  }

  async removeTemporary(): Promise<void> {}

  async read(): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  async readRange(): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  async exists(): Promise<boolean> {
    return true;
  }
}

async function fixture(input: {
  jobStatus?: "queued" | "cancelled";
  outboxStatus?: "pending" | "dispatching";
}) {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const resourceId = randomUUID();
  const versionId = randomUUID();
  const jobId = randomUUID();
  await db.insert(schema.organizations).values({ id: organizationId, name: "Outbox 测试组织" });
  await db.insert(schema.users).values({
    id: userId,
    email: `outbox-${jobId}@example.com`,
    name: "Outbox 测试用户",
    passwordHash: "not-used"
  });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "Outbox 测试空间",
    createdBy: userId
  });
  await db.insert(schema.resources).values({
    id: resourceId,
    spaceId,
    name: "outbox.md",
    status: input.jobStatus === "cancelled" ? "cancelled" : "queued",
    createdBy: userId
  });
  await db.insert(schema.resourceVersions).values({
    id: versionId,
    resourceId,
    version: 1,
    originalName: "outbox.md",
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
    kind: "resource.process",
    status: input.jobStatus ?? "queued",
    stage: input.jobStatus ?? "queued",
    ...(input.jobStatus === "cancelled" ? { finishedAt: new Date() } : {})
  });
  const [outbox] = await db
    .insert(schema.jobOutbox)
    .values({
      processingJobId: jobId,
      resourceVersionId: versionId,
      status: input.outboxStatus ?? "pending",
      ...(input.outboxStatus === "dispatching"
        ? {
            dispatchToken: randomUUID(),
            dispatchLeaseExpiresAt: new Date(Date.now() - 60_000)
          }
        : {})
    })
    .returning();
  return { db, organizationId, resourceId, versionId, jobId, outboxId: outbox!.id };
}

async function uploadFixture() {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  await db
    .insert(schema.organizations)
    .values({ id: organizationId, name: "上传 Outbox 测试组织" });
  await db.insert(schema.users).values({
    id: userId,
    email: `upload-outbox-${spaceId}@example.com`,
    name: "上传 Outbox 测试用户",
    passwordHash: "not-used"
  });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "上传 Outbox 测试空间",
    createdBy: userId
  });
  return { db, organizationId, userId, spaceId };
}

afterAll(async () => closeDatabase());

describe("processing job outbox", () => {
  test("persists an upload and pending outbox intent when the immediate queue send fails", async () => {
    const value = await uploadFixture();
    try {
      const result = await uploadResource(
        {
          spaceId: value.spaceId,
          userId: value.userId,
          name: "delayed.md",
          mimeType: "text/markdown",
          bytes: new TextEncoder().encode("延迟投递资料"),
          compileProfile: "knowledge"
        },
        new MemoryBlobStore(),
        new UnavailableUploadQueue(true)
      );
      expect(result).toMatchObject({ duplicate: false });
      if (result.duplicate) throw new Error("UPLOAD_OUTBOX_FIXTURE_DUPLICATED");
      const jobId = result.job?.id;
      const versionId = result.version?.id;
      if (!jobId || !versionId) throw new Error("UPLOAD_OUTBOX_FIXTURE_INCOMPLETE");
      const [job] = await value.db
        .select()
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.id, jobId));
      const [outbox] = await value.db
        .select()
        .from(schema.jobOutbox)
        .where(eq(schema.jobOutbox.processingJobId, jobId));
      expect(job).toMatchObject({ status: "queued", queueJobId: null });
      expect(outbox).toMatchObject({
        resourceVersionId: versionId,
        status: "pending",
        lastErrorCode: "QUEUE_PUBLISH_FAILED"
      });
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("keeps a queued job pending after the first broker failure and dispatches it later", async () => {
    const value = await fixture({});
    try {
      const unavailable = new ControlledQueue(true);
      await expect(
        dispatchPendingProcessingOutbox(unavailable, 1, undefined, value.jobId)
      ).resolves.toEqual({
        dispatched: 0,
        discarded: 0,
        failed: 1
      });
      const [pending] = await value.db
        .select()
        .from(schema.jobOutbox)
        .where(eq(schema.jobOutbox.id, value.outboxId));
      const [job] = await value.db
        .select()
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.id, value.jobId));
      expect(pending).toMatchObject({
        status: "pending",
        attemptCount: 1,
        lastErrorCode: "QUEUE_PUBLISH_FAILED"
      });
      expect(job).toMatchObject({ status: "queued", queueJobId: null });

      const available = new ControlledQueue(false);
      await expect(
        dispatchPendingProcessingOutbox(available, 1, undefined, value.jobId)
      ).resolves.toEqual({
        dispatched: 1,
        discarded: 0,
        failed: 0
      });
      const [sent] = await value.db
        .select()
        .from(schema.jobOutbox)
        .where(eq(schema.jobOutbox.id, value.outboxId));
      const [queued] = await value.db
        .select()
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.id, value.jobId));
      expect(sent).toMatchObject({
        status: "sent",
        attemptCount: 2,
        queueJobId: expect.any(String)
      });
      expect(queued?.queueJobId).toBe(sent?.queueJobId);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("allows only one concurrent drain to publish a pending job", async () => {
    const value = await fixture({});
    try {
      const queue = new ControlledQueue(false);
      const result = await Promise.all([
        dispatchPendingProcessingOutbox(queue, 1, undefined, value.jobId),
        dispatchPendingProcessingOutbox(queue, 1, undefined, value.jobId)
      ]);
      expect(result.reduce((sum, item) => sum + item.dispatched, 0)).toBe(1);
      expect(queue.published).toEqual([{ jobId: value.jobId, resourceVersionId: value.versionId }]);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("reclaims an expired dispatch lease but discards a cancelled job", async () => {
    const expired = await fixture({ outboxStatus: "dispatching" });
    const cancelled = await fixture({ jobStatus: "cancelled" });
    try {
      const queue = new ControlledQueue(false);
      await expect(
        dispatchPendingProcessingOutbox(queue, 1, undefined, expired.jobId)
      ).resolves.toEqual({
        dispatched: 1,
        discarded: 0,
        failed: 0
      });
      await expect(
        dispatchPendingProcessingOutbox(queue, 1, undefined, cancelled.jobId)
      ).resolves.toEqual({
        dispatched: 0,
        discarded: 1,
        failed: 0
      });
      expect(queue.published).toEqual([
        { jobId: expired.jobId, resourceVersionId: expired.versionId }
      ]);
      const [discarded] = await cancelled.db
        .select()
        .from(schema.jobOutbox)
        .where(eq(schema.jobOutbox.id, cancelled.outboxId));
      expect(discarded?.status).toBe("discarded");
    } finally {
      await expired.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, expired.organizationId));
      await cancelled.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, cancelled.organizationId));
    }
  });
});
