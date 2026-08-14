import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  acquireWikiPublicationLease,
  closeDatabase,
  getDatabase,
  heartbeatWikiPublicationLease,
  releaseWikiPublicationLease,
  schema,
  withWikiPublicationLease
} from "../src/index";

const enabled = Boolean(process.env.DATABASE_URL);
const test = enabled ? it : it.skip;

afterAll(async () => closeDatabase());

describe("wiki publication lease", () => {
  test("allows one owner, prevents wrong release and permits expired takeover", async () => {
    const db = getDatabase();
    const organizationId = randomUUID();
    const userId = randomUUID();
    const spaceId = randomUUID();
    await db.insert(schema.organizations).values({ id: organizationId, name: "锁测试组织" });
    await db.insert(schema.users).values({
      id: userId,
      email: `lease-${spaceId}@example.com`,
      name: "锁测试用户",
      passwordHash: "not-used"
    });
    await db.insert(schema.knowledgeSpaces).values({
      id: spaceId,
      organizationId,
      name: "锁测试空间",
      createdBy: userId
    });
    try {
      const leaseMs = 300;
      const first = await acquireWikiPublicationLease(spaceId, "owner-a", "test", leaseMs);
      expect(first?.ownerToken).toBe("owner-a");
      expect(await acquireWikiPublicationLease(spaceId, "owner-b", "test", leaseMs)).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await heartbeatWikiPublicationLease(first!, leaseMs)).toBe(true);
      await releaseWikiPublicationLease({ ...first!, ownerToken: "wrong-owner" });
      expect(await acquireWikiPublicationLease(spaceId, "owner-b", "test", leaseMs)).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, leaseMs + 60));
      const second = await acquireWikiPublicationLease(spaceId, "owner-b", "test", leaseMs);
      expect(second?.ownerToken).toBe("owner-b");
      await releaseWikiPublicationLease(second!);

      const result = await withWikiPublicationLease(spaceId, "test.wrapper", async () => {
        expect(await acquireWikiPublicationLease(spaceId, "owner-c", "test", leaseMs)).toBeNull();
        return "published";
      });
      expect(result).toBe("published");
      const afterWrapper = await acquireWikiPublicationLease(spaceId, "owner-c", "test", leaseMs);
      expect(afterWrapper?.ownerToken).toBe("owner-c");
      await releaseWikiPublicationLease(afterWrapper!);
    } finally {
      await db.delete(schema.organizations).where(eq(schema.organizations.id, organizationId));
    }
  });

  test("heartbeats short leases before expiry and preserves a successor after lease loss", async () => {
    const db = getDatabase();
    const organizationId = randomUUID();
    const userId = randomUUID();
    const spaceId = randomUUID();
    await db.insert(schema.organizations).values({ id: organizationId, name: "短租约锁测试组织" });
    await db.insert(schema.users).values({
      id: userId,
      email: `short-lease-${spaceId}@example.com`,
      name: "短租约锁测试用户",
      passwordHash: "not-used"
    });
    await db.insert(schema.knowledgeSpaces).values({
      id: spaceId,
      organizationId,
      name: "短租约锁测试空间",
      createdBy: userId
    });
    try {
      const published = await withWikiPublicationLease(
        spaceId,
        "test.short-heartbeat",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 180));
          expect(
            await acquireWikiPublicationLease(spaceId, "owner-waiting", "test", 500)
          ).toBeNull();
          return "published";
        },
        { leaseMs: 500, heartbeatMs: 50 }
      );
      expect(published).toBe("published");

      await expect(
        withWikiPublicationLease(
          spaceId,
          "test.lease-loss",
          async () => {
            await db
              .update(schema.wikiPublicationLocks)
              .set({ ownerToken: "owner-successor", expiresAt: new Date(Date.now() + 5_000) })
              .where(eq(schema.wikiPublicationLocks.spaceId, spaceId));
            await new Promise((resolve) => setTimeout(resolve, 120));
          },
          { leaseMs: 500, heartbeatMs: 50 }
        )
      ).rejects.toThrow("WIKI_PUBLICATION_LEASE_LOST");

      const [successor] = await db
        .select()
        .from(schema.wikiPublicationLocks)
        .where(eq(schema.wikiPublicationLocks.spaceId, spaceId));
      expect(successor?.ownerToken).toBe("owner-successor");
    } finally {
      await db.delete(schema.organizations).where(eq(schema.organizations.id, organizationId));
    }
  });

  test("allows only one concurrent publication wrapper into a space", async () => {
    const db = getDatabase();
    const organizationId = randomUUID();
    const userId = randomUUID();
    const spaceId = randomUUID();
    await db.insert(schema.organizations).values({ id: organizationId, name: "并发锁测试组织" });
    await db.insert(schema.users).values({
      id: userId,
      email: `concurrent-lease-${spaceId}@example.com`,
      name: "并发锁测试用户",
      passwordHash: "not-used"
    });
    await db.insert(schema.knowledgeSpaces).values({
      id: spaceId,
      organizationId,
      name: "并发锁测试空间",
      createdBy: userId
    });
    try {
      let signalStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const first = withWikiPublicationLease(
        spaceId,
        "test.concurrent.first",
        async () => {
          signalStarted?.();
          await new Promise((resolve) => setTimeout(resolve, 60));
          return "first";
        },
        { leaseMs: 200, heartbeatMs: 20 }
      );
      await started;
      await expect(
        withWikiPublicationLease(spaceId, "test.concurrent.second", async () => "second")
      ).rejects.toThrow("WIKI_PUBLICATION_LOCKED");
      await expect(first).resolves.toBe("first");
      const afterFirst = await acquireWikiPublicationLease(spaceId, "owner-after", "test", 100);
      expect(afterFirst?.ownerToken).toBe("owner-after");
      await releaseWikiPublicationLease(afterFirst!);
    } finally {
      await db.delete(schema.organizations).where(eq(schema.organizations.id, organizationId));
    }
  });
});
