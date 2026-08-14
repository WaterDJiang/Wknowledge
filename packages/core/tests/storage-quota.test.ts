import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { BlobStore } from "@wknowledge/blob-store";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import {
  CHUNKED_UPLOAD_PART_BYTES,
  createChunkedUploadSession,
  getChunkedUploadSession,
  readOrganizationStorageUsage,
  reserveDerivedStorageWrite,
  uploadResource,
  type JobQueue
} from "../src/index";

const test = process.env.DATABASE_URL ? it : it.skip;

class MemoryBlobStore implements BlobStore {
  writes = 0;

  async putImmutable(key: string): Promise<string> {
    this.writes += 1;
    return `local://${key}`;
  }

  async putTemporary(key: string): Promise<string> {
    return `local://.temporary/${key}`;
  }

  async composeTemporary(_parts: readonly string[], key: string): Promise<string> {
    return this.putImmutable(key);
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

class MemoryQueue implements JobQueue {
  async publish(): Promise<string> {
    return randomUUID();
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async resume(): Promise<boolean> {
    return false;
  }
}

async function fixture(storageQuotaBytes: number) {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  await db
    .insert(schema.organizations)
    .values({ id: organizationId, name: "配额测试组织", storageQuotaBytes });
  await db.insert(schema.users).values({
    id: userId,
    email: `quota-${spaceId}@example.com`,
    name: "配额测试用户",
    passwordHash: "not-used"
  });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "配额测试空间",
    createdBy: userId
  });
  return { db, organizationId, userId, spaceId };
}

afterAll(async () => closeDatabase());

describe("storage quota reservations", () => {
  test("rejects a direct upload before writing a blob when the organization quota is exhausted", async () => {
    const value = await fixture(4);
    try {
      const blobStore = new MemoryBlobStore();
      await expect(
        uploadResource(
          {
            spaceId: value.spaceId,
            userId: value.userId,
            name: "too-large.md",
            mimeType: "text/markdown",
            bytes: new TextEncoder().encode("five!"),
            compileProfile: "knowledge"
          },
          blobStore,
          new MemoryQueue()
        )
      ).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
      expect(blobStore.writes).toBe(0);
      await expect(
        value.db.select().from(schema.resources).where(eq(schema.resources.spaceId, value.spaceId))
      ).resolves.toEqual([]);
      await expect(
        value.db
          .select()
          .from(schema.storageReservations)
          .where(eq(schema.storageReservations.organizationId, value.organizationId))
      ).resolves.toEqual([]);
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
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.spaceId, value.spaceId))
      ).resolves.toEqual([]);
      await expect(
        value.db
          .select()
          .from(schema.jobOutbox)
          .innerJoin(
            schema.processingJobs,
            eq(schema.jobOutbox.processingJobId, schema.processingJobs.id)
          )
          .where(eq(schema.processingJobs.spaceId, value.spaceId))
      ).resolves.toEqual([]);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("rejects a chunked session before reserving capacity when local storage preflight fails", async () => {
    const value = await fixture(CHUNKED_UPLOAD_PART_BYTES * 3);
    try {
      await expect(
        createChunkedUploadSession(
          {
            spaceId: value.spaceId,
            userId: value.userId,
            name: "磁盘不足资料.md",
            mimeType: "text/markdown",
            byteSize: CHUNKED_UPLOAD_PART_BYTES * 3,
            sha256: randomUUID().replaceAll("-", "").padEnd(64, "0"),
            compileProfile: "knowledge"
          },
          { assertWriteCapacity: async () => Promise.reject(new Error("BLOB_STORAGE_FULL")) }
        )
      ).rejects.toThrow("BLOB_STORAGE_FULL");
      await expect(
        value.db
          .select()
          .from(schema.resourceUploads)
          .where(eq(schema.resourceUploads.spaceId, value.spaceId))
      ).resolves.toEqual([]);
      await expect(
        value.db
          .select()
          .from(schema.storageReservations)
          .where(eq(schema.storageReservations.organizationId, value.organizationId))
      ).resolves.toEqual([]);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("serializes concurrent chunked-session reservations and ignores expired reservations", async () => {
    const value = await fixture(CHUNKED_UPLOAD_PART_BYTES * 4 + 1);
    try {
      await value.db.insert(schema.storageReservations).values({
        id: randomUUID(),
        organizationId: value.organizationId,
        byteSize: CHUNKED_UPLOAD_PART_BYTES * 4,
        expiresAt: new Date(Date.now() - 1_000)
      });
      const input = (name: string) =>
        createChunkedUploadSession({
          spaceId: value.spaceId,
          userId: value.userId,
          name,
          mimeType: "text/markdown",
          byteSize: CHUNKED_UPLOAD_PART_BYTES * 3,
          sha256: randomUUID().replaceAll("-", "").padEnd(64, "0"),
          compileProfile: "knowledge"
        });
      const results = await Promise.allSettled([input("first.md"), input("second.md")]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        reason: expect.objectContaining({ message: "STORAGE_QUOTA_EXCEEDED" })
      });
      const usage = await readOrganizationStorageUsage(value.organizationId);
      expect(usage).toMatchObject({
        quotaBytes: CHUNKED_UPLOAD_PART_BYTES * 4 + 1,
        usedBytes: 0,
        reservedBytes: CHUNKED_UPLOAD_PART_BYTES * 3,
        availableBytes: CHUNKED_UPLOAD_PART_BYTES + 1
      });
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("releases a direct-upload reservation after persistence and counts the immutable blob once", async () => {
    const value = await fixture(100);
    try {
      const bytes = new TextEncoder().encode("占用空间");
      const result = await uploadResource(
        {
          spaceId: value.spaceId,
          userId: value.userId,
          name: "stored.md",
          mimeType: "text/markdown",
          bytes,
          compileProfile: "knowledge"
        },
        new MemoryBlobStore(),
        new MemoryQueue()
      );
      expect(result.duplicate).toBe(false);
      const usage = await readOrganizationStorageUsage(value.organizationId);
      expect(usage).toMatchObject({
        usedBytes: bytes.byteLength,
        reservedBytes: 0,
        availableBytes: 100 - bytes.byteLength
      });
      await expect(
        value.db
          .select()
          .from(schema.storageReservations)
          .where(eq(schema.storageReservations.organizationId, value.organizationId))
      ).resolves.toEqual([]);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("includes committed compiled output in organization storage and rejects growth above quota", async () => {
    const value = await fixture(10);
    try {
      const assetKey = `compiled:${value.spaceId}:${randomUUID()}`;
      const first = await reserveDerivedStorageWrite({
        organizationId: value.organizationId,
        assetKey,
        byteSize: 8
      });
      await first.commit();
      await expect(readOrganizationStorageUsage(value.organizationId)).resolves.toMatchObject({
        usedBytes: 8,
        reservedBytes: 0,
        availableBytes: 2
      });
      const growth = await reserveDerivedStorageWrite({
        organizationId: value.organizationId,
        assetKey,
        byteSize: 10
      });
      await growth.commit();
      await expect(readOrganizationStorageUsage(value.organizationId)).resolves.toMatchObject({
        usedBytes: 10,
        reservedBytes: 0,
        availableBytes: 0
      });
      const shrink = await reserveDerivedStorageWrite({
        organizationId: value.organizationId,
        assetKey,
        byteSize: 6
      });
      await shrink.commit();
      await expect(readOrganizationStorageUsage(value.organizationId)).resolves.toMatchObject({
        usedBytes: 6,
        reservedBytes: 0,
        availableBytes: 4
      });
      await expect(
        reserveDerivedStorageWrite({
          organizationId: value.organizationId,
          assetKey: `learning-report:${randomUUID()}`,
          byteSize: 5
        })
      ).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("expires a chunked session, releases its reservation, and admits a replacement session", async () => {
    const value = await fixture(CHUNKED_UPLOAD_PART_BYTES * 3);
    try {
      const input = (name: string) =>
        createChunkedUploadSession({
          spaceId: value.spaceId,
          userId: value.userId,
          name,
          mimeType: "text/markdown",
          byteSize: CHUNKED_UPLOAD_PART_BYTES * 3,
          sha256: randomUUID().replaceAll("-", "").padEnd(64, "0"),
          compileProfile: "knowledge"
        });
      const first = await input("expired.md");
      await value.db
        .update(schema.resourceUploads)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.resourceUploads.id, first.uploadId));

      await expect(getChunkedUploadSession(first.uploadId, value.userId)).rejects.toThrow(
        "UPLOAD_EXPIRED"
      );
      await expect(
        value.db
          .select()
          .from(schema.storageReservations)
          .where(eq(schema.storageReservations.organizationId, value.organizationId))
      ).resolves.toEqual([]);
      await expect(input("replacement.md")).resolves.toMatchObject({ totalParts: 3 });
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });
});
