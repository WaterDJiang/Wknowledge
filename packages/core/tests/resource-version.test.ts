import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { BlobStore } from "@wknowledge/blob-store";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import {
  recompileResourceVersion,
  replaceResourceVersion,
  uploadResource,
  type JobQueue
} from "../src/index";

const test = process.env.DATABASE_URL ? it : it.skip;

class MemoryBlobStore implements BlobStore {
  readonly uris: string[] = [];

  async putImmutable(key: string, _data: Uint8Array): Promise<string> {
    const uri = `local://${key}`;
    this.uris.push(uri);
    return uri;
  }

  async putTemporary(key: string): Promise<string> {
    return `local://.temporary/${key}`;
  }

  async composeTemporary(_parts: readonly string[], immutableKey: string): Promise<string> {
    return this.putImmutable(immutableKey, new Uint8Array());
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
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const db = getDatabase();
  await db.insert(schema.organizations).values({ id: organizationId, name: "资源版本测试组织" });
  await db.insert(schema.users).values({
    id: userId,
    email: `versions-${spaceId}@example.com`,
    name: "资源版本测试用户",
    passwordHash: "not-used"
  });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "资源版本测试空间",
    createdBy: userId
  });
  return { db, organizationId, userId, spaceId };
}

afterAll(async () => closeDatabase());

describe("resource versions", () => {
  test("replaces a resource with an immutable next version without changing version one", async () => {
    const value = await fixture();
    try {
      const blobStore = new MemoryBlobStore();
      const queue = new MemoryQueue();
      const first = await uploadResource(
        {
          spaceId: value.spaceId,
          userId: value.userId,
          name: "学习资料.md",
          mimeType: "text/markdown",
          bytes: new TextEncoder().encode("第一版"),
          compileProfile: "knowledge"
        },
        blobStore,
        queue
      );
      if (first.duplicate || !first.resource || !first.version)
        throw new Error("VERSION_FIXTURE_INVALID");
      const replacement = await replaceResourceVersion(
        {
          resourceId: first.resource.id,
          spaceId: value.spaceId,
          userId: value.userId,
          name: "学习资料-修订.md",
          mimeType: "text/markdown",
          bytes: new TextEncoder().encode("第二版"),
          compileProfile: "knowledge"
        },
        blobStore,
        queue
      );
      expect(replacement).toMatchObject({
        duplicate: false,
        resource: { id: first.resource.id, name: "学习资料-修订.md", status: "queued" },
        version: { version: 2, originalName: "学习资料-修订.md" },
        job: { resourceVersionId: expect.any(String), kind: "resource.process" }
      });
      const versions = await value.db
        .select()
        .from(schema.resourceVersions)
        .where(eq(schema.resourceVersions.resourceId, first.resource.id))
        .orderBy(asc(schema.resourceVersions.version));
      expect(versions).toHaveLength(2);
      expect(versions[0]).toMatchObject({ version: 1, originalName: "学习资料.md" });
      expect(versions[1]).toMatchObject({ version: 2, originalName: "学习资料-修订.md" });
      expect(versions[0]?.blobUri).not.toBe(versions[1]?.blobUri);
      const repeated = await replaceResourceVersion(
        {
          resourceId: first.resource.id,
          spaceId: value.spaceId,
          userId: value.userId,
          name: "学习资料-修订.md",
          mimeType: "text/markdown",
          bytes: new TextEncoder().encode("第二版"),
          compileProfile: "knowledge"
        },
        blobStore,
        queue
      );
      expect(repeated).toMatchObject({ duplicate: true, version: { version: 2 } });
      expect(queue.published).toHaveLength(2);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("reuses an existing same-space immutable blob when another resource is replaced with identical content", async () => {
    const value = await fixture();
    try {
      const blobStore = new MemoryBlobStore();
      const queue = new MemoryQueue();
      const shared = await uploadResource(
        {
          spaceId: value.spaceId,
          userId: value.userId,
          name: "共享原件.md",
          mimeType: "text/markdown",
          bytes: new TextEncoder().encode("相同的原始内容"),
          compileProfile: "knowledge"
        },
        blobStore,
        queue
      );
      const target = await uploadResource(
        {
          spaceId: value.spaceId,
          userId: value.userId,
          name: "待替换资料.md",
          mimeType: "text/markdown",
          bytes: new TextEncoder().encode("不同的原始内容"),
          compileProfile: "knowledge"
        },
        blobStore,
        queue
      );
      if (shared.duplicate || target.duplicate || !shared.version || !target.resource)
        throw new Error("VERSION_REUSE_FIXTURE_INVALID");

      const replacement = await replaceResourceVersion(
        {
          resourceId: target.resource.id,
          spaceId: value.spaceId,
          userId: value.userId,
          name: "待替换资料.md",
          mimeType: "text/markdown",
          bytes: new TextEncoder().encode("相同的原始内容"),
          compileProfile: "knowledge"
        },
        blobStore,
        queue
      );

      expect(replacement).toMatchObject({ duplicate: false, version: { version: 2 } });
      expect(replacement.version?.blobUri).toBe(shared.version.blobUri);
      expect(blobStore.uris).toHaveLength(2);
      expect(replacement.resource?.id).toBe(target.resource.id);
      expect(queue.published).toHaveLength(3);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("recompiles the current immutable source into a new compile-profile version", async () => {
    const value = await fixture();
    try {
      const blobStore = new MemoryBlobStore();
      const queue = new MemoryQueue();
      const initial = await uploadResource(
        {
          spaceId: value.spaceId,
          userId: value.userId,
          name: "历史资料.pdf",
          mimeType: "application/pdf",
          bytes: new TextEncoder().encode("%PDF-历史资料"),
          compileProfile: "reference"
        },
        blobStore,
        queue
      );
      if (initial.duplicate || !initial.resource || !initial.version)
        throw new Error("RECOMPILE_FIXTURE_INVALID");

      const recompiled = await recompileResourceVersion(
        {
          resourceId: initial.resource.id,
          spaceId: value.spaceId,
          userId: value.userId,
          compileProfile: "knowledge"
        },
        queue
      );
      expect(recompiled).toMatchObject({
        duplicate: false,
        resource: { id: initial.resource.id, status: "queued" },
        version: { version: 2, compileProfile: "knowledge", blobUri: initial.version.blobUri },
        job: { kind: "resource.process", resourceVersionId: expect.any(String) }
      });
      const versions = await value.db
        .select()
        .from(schema.resourceVersions)
        .where(eq(schema.resourceVersions.resourceId, initial.resource.id))
        .orderBy(asc(schema.resourceVersions.version));
      expect(versions).toHaveLength(2);
      expect(versions[0]).toMatchObject({ version: 1, compileProfile: "reference" });
      expect(versions[1]).toMatchObject({
        version: 2,
        compileProfile: "knowledge",
        blobUri: versions[0]?.blobUri
      });
      await expect(
        value.db
          .select()
          .from(schema.jobOutbox)
          .where(eq(schema.jobOutbox.resourceVersionId, recompiled.version.id))
      ).resolves.toHaveLength(1);
      await expect(
        value.db
          .select()
          .from(schema.auditEvents)
          .where(eq(schema.auditEvents.targetId, recompiled.version.id))
      ).resolves.toEqual([
        expect.objectContaining({
          action: "resource.recompiled",
          metadata: expect.objectContaining({
            resourceId: initial.resource.id,
            fromVersionId: initial.version.id,
            fromCompileProfile: "reference",
            toCompileProfile: "knowledge"
          })
        })
      ]);
      const repeated = await recompileResourceVersion(
        {
          resourceId: initial.resource.id,
          spaceId: value.spaceId,
          userId: value.userId,
          compileProfile: "knowledge"
        },
        queue
      );
      expect(repeated).toMatchObject({ duplicate: true, version: { id: recompiled.version.id } });
      expect(queue.published).toHaveLength(2);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });
});
