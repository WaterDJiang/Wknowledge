import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { LocalBlobStore } from "@wknowledge/blob-store";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import { auditLocalBlobConsistency } from "../src/index";

const test = process.env.DATABASE_URL ? it : it.skip;

async function fixture() {
  const db = getDatabase();
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const otherSpaceId = randomUUID();
  const resourceId = randomUUID();
  const missingResourceId = randomUUID();
  const otherResourceId = randomUUID();
  const existingVersionId = randomUUID();
  const missingVersionId = randomUUID();
  const uncheckedVersionId = randomUUID();
  const otherVersionId = randomUUID();
  const root = await mkdtemp(path.join(tmpdir(), "wknowledge-blob-audit-"));
  await db.insert(schema.organizations).values([
    { id: organizationId, name: "Blob 巡检测试组织" },
    { id: otherOrganizationId, name: "其他组织" }
  ]);
  await db.insert(schema.users).values({
    id: userId,
    email: `blob-audit-${organizationId}@example.com`,
    name: "Blob 巡检测试用户",
    passwordHash: "not-used"
  });
  await db.insert(schema.knowledgeSpaces).values([
    { id: spaceId, organizationId, name: "巡检空间", createdBy: userId },
    { id: otherSpaceId, organizationId: otherOrganizationId, name: "其他空间", createdBy: userId }
  ]);
  await db.insert(schema.resources).values([
    { id: resourceId, spaceId, name: "存在资料", createdBy: userId },
    { id: missingResourceId, spaceId, name: "缺失资料", createdBy: userId },
    { id: otherResourceId, spaceId: otherSpaceId, name: "其他资料", createdBy: userId }
  ]);
  await db.insert(schema.resourceVersions).values([
    {
      id: existingVersionId,
      resourceId,
      version: 1,
      originalName: "存在资料.md",
      mimeType: "text/markdown",
      byteSize: 7,
      sha256: randomUUID().replaceAll("-", ""),
      blobUri: `local://${spaceId}/existing/source.md`,
      compileProfile: "knowledge",
      createdBy: userId
    },
    {
      id: missingVersionId,
      resourceId: missingResourceId,
      version: 1,
      originalName: "缺失资料.md",
      mimeType: "text/markdown",
      byteSize: 7,
      sha256: randomUUID().replaceAll("-", ""),
      blobUri: `local://${spaceId}/missing/source.md`,
      compileProfile: "knowledge",
      createdBy: userId
    },
    {
      id: uncheckedVersionId,
      resourceId: missingResourceId,
      version: 2,
      originalName: "远端资料.md",
      mimeType: "text/markdown",
      byteSize: 7,
      sha256: randomUUID().replaceAll("-", ""),
      blobUri: "s3://private-bucket/object",
      compileProfile: "knowledge",
      createdBy: userId
    },
    {
      id: otherVersionId,
      resourceId: otherResourceId,
      version: 1,
      originalName: "其他资料.md",
      mimeType: "text/markdown",
      byteSize: 7,
      sha256: randomUUID().replaceAll("-", ""),
      blobUri: `local://${otherSpaceId}/secret/source.md`,
      compileProfile: "knowledge",
      createdBy: userId
    }
  ]);
  return {
    db,
    organizationId,
    otherOrganizationId,
    existingVersionId,
    missingVersionId,
    uncheckedVersionId,
    otherVersionId,
    root
  };
}

afterAll(async () => closeDatabase());

describe("local blob consistency audit", () => {
  test("reports missing and unreferenced local blobs without modifying records or temporary parts", async () => {
    const value = await fixture();
    try {
      const blobStore = new LocalBlobStore(value.root);
      const [space] = await value.db
        .select({ id: schema.knowledgeSpaces.id })
        .from(schema.knowledgeSpaces)
        .where(eq(schema.knowledgeSpaces.organizationId, value.organizationId));
      const [otherSpace] = await value.db
        .select({ id: schema.knowledgeSpaces.id })
        .from(schema.knowledgeSpaces)
        .where(eq(schema.knowledgeSpaces.organizationId, value.otherOrganizationId));
      if (!space || !otherSpace) throw new Error("BLOB_AUDIT_FIXTURE_INVALID");
      await blobStore.putImmutable(`${space.id}/existing/source.md`, Buffer.from("source"));
      await blobStore.putImmutable(`${space.id}/unreferenced/source.md`, Buffer.from("orphan"));
      await blobStore.putImmutable(`${otherSpace.id}/private/source.md`, Buffer.from("other"));
      await blobStore.putTemporary("upload/part-1", Buffer.from("temporary"));
      const before = await value.db
        .select()
        .from(schema.resourceVersions)
        .where(eq(schema.resourceVersions.id, value.existingVersionId));

      const report = await auditLocalBlobConsistency({
        organizationId: value.organizationId,
        blobStore
      });

      expect(report).toMatchObject({
        referencedCount: 3,
        inventoryCount: 2,
        verifiedReferenceCount: 1,
        missingReferenceCount: 1,
        unreferencedBlobCount: 1,
        uncheckedReferenceCount: 1,
        missingResourceVersionIds: [value.missingVersionId],
        unreferencedUriDigests: [expect.stringMatching(/^[a-f0-9]{16}$/)]
      });
      expect(JSON.stringify(report)).not.toContain("local://");
      expect(JSON.stringify(report)).not.toContain("private-bucket");
      expect(report.missingResourceVersionIds).not.toContain(value.otherVersionId);
      expect(await blobStore.exists("local://.temporary/upload/part-1")).toBe(true);
      expect(
        await value.db
          .select()
          .from(schema.resourceVersions)
          .where(eq(schema.resourceVersions.id, value.existingVersionId))
      ).toEqual(before);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.otherOrganizationId));
      await rm(value.root, { recursive: true, force: true });
    }
  });
});
