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
  cleanupExpiredChunkedUploads,
  createChunkedUploadSession,
  markChunkedUploadFinalizationFailure,
  putChunkedUploadPart
} from "../src/index";

const test = process.env.DATABASE_URL ? it : it.skip;

async function fixture() {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  await db
    .insert(schema.organizations)
    .values({ id: organizationId, name: "过期上传清理测试组织" });
  await db.insert(schema.users).values({
    id: userId,
    email: `expired-upload-${spaceId}@example.com`,
    name: "过期上传清理测试用户",
    passwordHash: "not-used"
  });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "过期上传清理测试空间",
    createdBy: userId
  });
  const root = await mkdtemp(path.join(tmpdir(), "wknowledge-expired-upload-"));
  return { db, organizationId, userId, spaceId, root };
}

function bytes() {
  return Buffer.alloc(CHUNKED_UPLOAD_PART_BYTES * 3, "x");
}

async function createSession(value: Awaited<ReturnType<typeof fixture>>, name: string) {
  const content = bytes();
  return createChunkedUploadSession({
    spaceId: value.spaceId,
    userId: value.userId,
    name,
    mimeType: "text/markdown",
    byteSize: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
    compileProfile: "knowledge"
  });
}

async function addFirstPart(
  value: Awaited<ReturnType<typeof fixture>>,
  uploadId: string,
  store: LocalBlobStore
) {
  return putChunkedUploadPart({
    uploadId,
    userId: value.userId,
    partNumber: 1,
    bytes: bytes().subarray(0, CHUNKED_UPLOAD_PART_BYTES),
    blobStore: store
  });
}

afterAll(async () => closeDatabase());

describe("expired chunked upload cleanup", () => {
  test("retains finalizing parts during automatic retry, then fails, releases capacity, and cleans them after expiry", async () => {
    const value = await fixture();
    try {
      const store = new LocalBlobStore(value.root);
      const created = await createSession(value, "最终化失败资料.md");
      await addFirstPart(value, created.uploadId, store);
      await value.db
        .update(schema.resourceUploads)
        .set({ status: "finalizing" })
        .where(eq(schema.resourceUploads.id, created.uploadId));
      const [job] = await value.db
        .insert(schema.processingJobs)
        .values({
          id: randomUUID(),
          spaceId: value.spaceId,
          kind: "resource.upload.finalize",
          status: "queued",
          stage: "upload_finalize"
        })
        .returning();
      if (!job) throw new Error("TEST_JOB_CREATE_FAILED");
      const retry = await markChunkedUploadFinalizationFailure({
        uploadId: created.uploadId,
        jobId: job.id,
        errorCode: "UPLOAD_FINALIZATION_FAILED",
        errorMessage: "文件校验入库失败，请重新选择文件后提交",
        terminal: false
      });
      expect(retry).toEqual({ terminal: false, settled: true });
      await expect(
        value.db
          .select({ status: schema.resourceUploads.status })
          .from(schema.resourceUploads)
          .where(eq(schema.resourceUploads.id, created.uploadId))
      ).resolves.toEqual([{ status: "finalizing" }]);
      await expect(cleanupExpiredChunkedUploads(store)).resolves.toEqual({
        sessionsExpired: 0,
        partsDeleted: 0,
        partDeleteFailures: 0
      });

      const terminal = await markChunkedUploadFinalizationFailure({
        uploadId: created.uploadId,
        jobId: job.id,
        errorCode: "UPLOAD_FINALIZATION_FAILED",
        errorMessage: "文件校验入库失败，请重新选择文件后提交",
        terminal: true
      });
      expect(terminal).toEqual({ terminal: true, settled: true });
      await expect(
        value.db
          .select({
            status: schema.resourceUploads.status,
            errorCode: schema.resourceUploads.errorCode
          })
          .from(schema.resourceUploads)
          .where(eq(schema.resourceUploads.id, created.uploadId))
      ).resolves.toEqual([{ status: "failed", errorCode: "UPLOAD_FINALIZATION_FAILED" }]);
      await expect(
        value.db
          .select({ status: schema.processingJobs.status, stage: schema.processingJobs.stage })
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.id, job.id))
      ).resolves.toEqual([{ status: "failed", stage: "failed" }]);
      await expect(
        value.db.select().from(schema.resources).where(eq(schema.resources.spaceId, value.spaceId))
      ).resolves.toEqual([]);
      await expect(
        value.db
          .select()
          .from(schema.resourceVersions)
          .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
          .where(eq(schema.resources.spaceId, value.spaceId))
      ).resolves.toEqual([]);
      await expect(
        value.db
          .select()
          .from(schema.storageReservations)
          .where(eq(schema.storageReservations.organizationId, value.organizationId))
      ).resolves.toEqual([]);
      await value.db
        .update(schema.resourceUploads)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.resourceUploads.id, created.uploadId));
      await expect(cleanupExpiredChunkedUploads(store)).resolves.toEqual({
        sessionsExpired: 0,
        partsDeleted: 1,
        partDeleteFailures: 0
      });
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test("settles the finalization job when a finalizing upload expires", async () => {
    const value = await fixture();
    try {
      const created = await createSession(value, "最终化超时资料.md");
      await value.db
        .update(schema.resourceUploads)
        .set({ status: "expired", expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.resourceUploads.id, created.uploadId));
      const [job] = await value.db
        .insert(schema.processingJobs)
        .values({
          id: randomUUID(),
          spaceId: value.spaceId,
          kind: "resource.upload.finalize",
          status: "queued",
          stage: "upload_finalize"
        })
        .returning();
      if (!job) throw new Error("TEST_JOB_CREATE_FAILED");
      await expect(
        markChunkedUploadFinalizationFailure({
          uploadId: created.uploadId,
          jobId: job.id,
          errorCode: "UPLOAD_EXPIRED",
          errorMessage: "上传会话已过期，请重新选择文件后提交",
          terminal: true
        })
      ).resolves.toEqual({ terminal: true, settled: true });
      await expect(
        value.db
          .select({
            status: schema.processingJobs.status,
            errorCode: schema.processingJobs.errorCode
          })
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.id, job.id))
      ).resolves.toEqual([{ status: "failed", errorCode: "UPLOAD_EXPIRED" }]);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("expires an open upload, deletes its temporary parts and releases its reservation", async () => {
    const value = await fixture();
    try {
      const store = new LocalBlobStore(value.root);
      const created = await createSession(value, "过期资料.md");
      await addFirstPart(value, created.uploadId, store);
      const partUri = `local://.temporary/${value.spaceId}/${created.uploadId}/parts/1`;
      await value.db
        .update(schema.resourceUploads)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.resourceUploads.id, created.uploadId));

      await expect(cleanupExpiredChunkedUploads(store)).resolves.toEqual({
        sessionsExpired: 1,
        partsDeleted: 1,
        partDeleteFailures: 0
      });
      await expect(store.exists(partUri)).resolves.toBe(false);
      await expect(
        value.db
          .select()
          .from(schema.resourceUploadParts)
          .where(eq(schema.resourceUploadParts.uploadId, created.uploadId))
      ).resolves.toEqual([]);
      await expect(
        value.db
          .select({ status: schema.resourceUploads.status })
          .from(schema.resourceUploads)
          .where(eq(schema.resourceUploads.id, created.uploadId))
      ).resolves.toEqual([{ status: "expired" }]);
      await expect(
        value.db
          .select()
          .from(schema.storageReservations)
          .where(eq(schema.storageReservations.organizationId, value.organizationId))
      ).resolves.toEqual([]);
      await expect(cleanupExpiredChunkedUploads(store)).resolves.toEqual({
        sessionsExpired: 0,
        partsDeleted: 0,
        partDeleteFailures: 0
      });
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test("keeps metadata for a failed deletion and does not touch a finalizing upload", async () => {
    const value = await fixture();
    try {
      const store = new LocalBlobStore(value.root);
      const failed = await createSession(value, "删除失败资料.md");
      await addFirstPart(value, failed.uploadId, store);
      const finalizing = await createSession(value, "最终化资料.md");
      await addFirstPart(value, finalizing.uploadId, store);
      const expiredAt = new Date(Date.now() - 1_000);
      await value.db
        .update(schema.resourceUploads)
        .set({ expiresAt: expiredAt })
        .where(eq(schema.resourceUploads.id, failed.uploadId));
      await value.db
        .update(schema.resourceUploads)
        .set({ status: "finalizing", expiresAt: expiredAt })
        .where(eq(schema.resourceUploads.id, finalizing.uploadId));

      await expect(
        cleanupExpiredChunkedUploads({
          removeTemporary: async () => {
            throw new Error("temporary delete failed");
          }
        })
      ).resolves.toEqual({ sessionsExpired: 1, partsDeleted: 0, partDeleteFailures: 1 });
      await expect(
        value.db
          .select()
          .from(schema.resourceUploadParts)
          .where(eq(schema.resourceUploadParts.uploadId, failed.uploadId))
      ).resolves.toHaveLength(1);
      await expect(
        value.db
          .select()
          .from(schema.resourceUploadParts)
          .where(eq(schema.resourceUploadParts.uploadId, finalizing.uploadId))
      ).resolves.toHaveLength(1);

      await expect(cleanupExpiredChunkedUploads(store)).resolves.toEqual({
        sessionsExpired: 0,
        partsDeleted: 1,
        partDeleteFailures: 0
      });
      await expect(
        value.db
          .select()
          .from(schema.resourceUploadParts)
          .where(eq(schema.resourceUploadParts.uploadId, finalizing.uploadId))
      ).resolves.toHaveLength(1);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await rm(value.root, { recursive: true, force: true });
    }
  });

  test("removes a temporary part when the session expires while that part is being recorded", async () => {
    const value = await fixture();
    try {
      const store = new LocalBlobStore(value.root);
      const created = await createSession(value, "竞争过期资料.md");
      const expiringStore = {
        async putTemporary(key: string, data: Uint8Array) {
          const uri = await store.putTemporary(key, data);
          await value.db
            .update(schema.resourceUploads)
            .set({ expiresAt: new Date(Date.now() - 1_000) })
            .where(eq(schema.resourceUploads.id, created.uploadId));
          return uri;
        },
        removeTemporary: store.removeTemporary.bind(store)
      };
      const partUri = `local://.temporary/${value.spaceId}/${created.uploadId}/parts/1`;

      await expect(
        putChunkedUploadPart({
          uploadId: created.uploadId,
          userId: value.userId,
          partNumber: 1,
          bytes: bytes().subarray(0, CHUNKED_UPLOAD_PART_BYTES),
          blobStore: expiringStore as unknown as LocalBlobStore
        })
      ).rejects.toThrow("UPLOAD_EXPIRED");
      await expect(store.exists(partUri)).resolves.toBe(false);
      await expect(
        value.db
          .select()
          .from(schema.resourceUploadParts)
          .where(eq(schema.resourceUploadParts.uploadId, created.uploadId))
      ).resolves.toEqual([]);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await rm(value.root, { recursive: true, force: true });
    }
  });
});
