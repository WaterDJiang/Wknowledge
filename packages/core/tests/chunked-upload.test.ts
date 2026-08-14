import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { LocalBlobStore } from "@wknowledge/blob-store";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import {
  CHUNKED_UPLOAD_PART_BYTES,
  createChunkedUploadSession,
  finalizeChunkedUpload,
  getChunkedUploadSession,
  putChunkedUploadPart,
  requestChunkedUploadFinalization,
  type JobQueue
} from "../src/index";

const test = process.env.DATABASE_URL ? it : it.skip;

class MemoryQueue implements JobQueue {
  readonly published: Array<{ jobId: string; resourceVersionId: string }> = [];

  async publish(
    name: "resource.process" | "resource.upload.finalize",
    payload: { jobId: string; resourceVersionId: string } | { jobId: string; uploadId: string }
  ): Promise<string> {
    if (name === "resource.process" && "resourceVersionId" in payload) this.published.push(payload);
    return randomUUID();
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async resume(): Promise<boolean> {
    return false;
  }
}

async function fixture() {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  await db.insert(schema.organizations).values({ id: organizationId, name: "分片上传测试组织" });
  await db.insert(schema.users).values({
    id: userId,
    email: `chunked-${spaceId}@example.com`,
    name: "分片上传测试用户",
    passwordHash: "not-used"
  });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "分片上传测试空间",
    createdBy: userId
  });
  const root = await mkdtemp(path.join(tmpdir(), "wknowledge-chunked-upload-"));
  return { db, organizationId, userId, spaceId, root };
}

function largeMarkdown(): Buffer {
  return Buffer.alloc(CHUNKED_UPLOAD_PART_BYTES * 3, "a");
}

function largeMp4(): Buffer {
  const bytes = Buffer.alloc(CHUNKED_UPLOAD_PART_BYTES * 3);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4, "ascii");
  bytes.write("isom", 8, "ascii");
  return bytes;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

afterAll(async () => closeDatabase());

describe("chunked upload", () => {
  test("resumes missing parts and creates one queued resource only after complete integrity checks", async () => {
    const value = await fixture();
    try {
      const bytes = largeMarkdown();
      const created = await createChunkedUploadSession({
        spaceId: value.spaceId,
        userId: value.userId,
        name: "大型学习资料.md",
        mimeType: "text/markdown",
        byteSize: bytes.byteLength,
        sha256: digest(bytes),
        compileProfile: "knowledge"
      });
      expect(created).toMatchObject({ partSize: CHUNKED_UPLOAD_PART_BYTES, totalParts: 3 });
      const store = new LocalBlobStore(value.root);
      await putChunkedUploadPart({
        uploadId: created.uploadId,
        userId: value.userId,
        partNumber: 1,
        bytes: bytes.subarray(0, CHUNKED_UPLOAD_PART_BYTES),
        blobStore: store
      });
      const resumed = await getChunkedUploadSession(created.uploadId, value.userId);
      expect(resumed.receivedParts).toEqual([1]);
      await expect(
        requestChunkedUploadFinalization({
          uploadId: created.uploadId,
          userId: value.userId,
          sha256: digest(bytes)
        })
      ).rejects.toThrow("UPLOAD_INCOMPLETE");
      await putChunkedUploadPart({
        uploadId: created.uploadId,
        userId: value.userId,
        partNumber: 2,
        bytes: bytes.subarray(CHUNKED_UPLOAD_PART_BYTES, CHUNKED_UPLOAD_PART_BYTES * 2),
        blobStore: store
      });
      await putChunkedUploadPart({
        uploadId: created.uploadId,
        userId: value.userId,
        partNumber: 3,
        bytes: bytes.subarray(CHUNKED_UPLOAD_PART_BYTES * 2),
        blobStore: store
      });
      const requested = await requestChunkedUploadFinalization({
        uploadId: created.uploadId,
        userId: value.userId,
        sha256: digest(bytes)
      });
      expect(requested).toMatchObject({
        resource: null,
        version: null,
        job: { kind: "resource.upload.finalize" }
      });
      const queue = new MemoryQueue();
      const completed = await finalizeChunkedUpload({
        uploadId: created.uploadId,
        userId: value.userId,
        blobStore: store,
        queue
      });
      expect(completed).toMatchObject({ duplicate: false, resource: { status: "queued" } });
      expect(queue.published).toHaveLength(1);
      expect(await getChunkedUploadSession(created.uploadId, value.userId)).toMatchObject({
        upload: { status: "completed" },
        receivedParts: [1, 2, 3]
      });
      await expect(
        value.db
          .select()
          .from(schema.storageReservations)
          .where(eq(schema.storageReservations.organizationId, value.organizationId))
      ).resolves.toEqual([]);
      const repeated = await finalizeChunkedUpload({
        uploadId: created.uploadId,
        userId: value.userId,
        blobStore: store,
        queue
      });
      expect(repeated.job?.id).toBe(completed.job?.id);
      expect(queue.published).toHaveLength(1);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test("keeps conflicting or malformed parts out of resources and jobs", async () => {
    const value = await fixture();
    try {
      const bytes = largeMarkdown();
      const created = await createChunkedUploadSession({
        spaceId: value.spaceId,
        userId: value.userId,
        name: "冲突资料.md",
        mimeType: "text/markdown",
        byteSize: bytes.byteLength,
        sha256: digest(bytes),
        compileProfile: "knowledge"
      });
      const store = new LocalBlobStore(value.root);
      await expect(
        putChunkedUploadPart({
          uploadId: created.uploadId,
          userId: value.userId,
          partNumber: 1,
          bytes: bytes.subarray(0, CHUNKED_UPLOAD_PART_BYTES - 1),
          blobStore: store
        })
      ).rejects.toThrow("UPLOAD_PART_SIZE_INVALID");
      await putChunkedUploadPart({
        uploadId: created.uploadId,
        userId: value.userId,
        partNumber: 1,
        bytes: bytes.subarray(0, CHUNKED_UPLOAD_PART_BYTES),
        blobStore: store
      });
      await expect(
        putChunkedUploadPart({
          uploadId: created.uploadId,
          userId: value.userId,
          partNumber: 1,
          bytes: Buffer.alloc(CHUNKED_UPLOAD_PART_BYTES, "b"),
          blobStore: store
        })
      ).rejects.toThrow("UPLOAD_PART_CONFLICT");
      const resources = await value.db
        .select()
        .from(schema.resources)
        .where(eq(schema.resources.spaceId, value.spaceId));
      const jobs = await value.db
        .select()
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.spaceId, value.spaceId));
      expect(resources).toHaveLength(0);
      expect(jobs).toHaveLength(0);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test("admits an MP4 through the resumable path without requiring a model provider", async () => {
    const value = await fixture();
    try {
      const bytes = largeMp4();
      const created = await createChunkedUploadSession({
        spaceId: value.spaceId,
        userId: value.userId,
        name: "课程录像.mp4",
        mimeType: "video/mp4",
        byteSize: bytes.byteLength,
        sha256: digest(bytes),
        compileProfile: "reference"
      });
      const store = new LocalBlobStore(value.root);
      for (let partNumber = 1; partNumber <= created.totalParts; partNumber += 1) {
        const start = (partNumber - 1) * created.partSize;
        await putChunkedUploadPart({
          uploadId: created.uploadId,
          userId: value.userId,
          partNumber,
          bytes: bytes.subarray(start, Math.min(start + created.partSize, bytes.byteLength)),
          blobStore: store
        });
      }
      await requestChunkedUploadFinalization({
        uploadId: created.uploadId,
        userId: value.userId,
        sha256: digest(bytes)
      });
      const queue = new MemoryQueue();
      const completed = await finalizeChunkedUpload({
        uploadId: created.uploadId,
        userId: value.userId,
        blobStore: store,
        queue
      });
      expect(completed).toMatchObject({
        duplicate: false,
        resource: { status: "queued" },
        version: { mimeType: "video/mp4", originalName: "课程录像.mp4" }
      });
      expect(queue.published).toHaveLength(1);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await rm(value.root, { recursive: true, force: true });
    }
  });
});
