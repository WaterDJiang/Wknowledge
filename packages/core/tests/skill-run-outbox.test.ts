import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import { dispatchPendingSkillRunOutbox, type SkillRunOutboxQueue } from "../src/index";

const test = process.env.DATABASE_URL ? it : it.skip;

class ControlledQueue implements SkillRunOutboxQueue {
  readonly published: string[] = [];

  constructor(private readonly fail: boolean) {}

  async publish(_name: "skill.run", payload: { skillRunId: string }): Promise<string> {
    this.published.push(payload.skillRunId);
    if (this.fail) throw new Error("queue unavailable");
    return randomUUID();
  }
}

async function fixture(status: "queued" | "stopped" = "queued") {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const sessionId = randomUUID();
  await db
    .insert(schema.organizations)
    .values({ id: organizationId, name: "SkillRun Outbox 组织" });
  await db.insert(schema.users).values({
    id: userId,
    email: `skill-run-outbox-${userId}@example.com`,
    name: "SkillRun 用户",
    passwordHash: "not-used"
  });
  await db.insert(schema.agentSessions).values({
    id: sessionId,
    organizationId,
    userId,
    title: "SkillRun Outbox 会话"
  });
  const [run] = await db
    .insert(schema.skillRuns)
    .values({
      sessionId,
      userId,
      skillId: "wiki-lint",
      skillVersion: "1.0.0",
      skillDigest: `sha256:${"a".repeat(64)}`,
      inputSummary: "校验当前 Wiki",
      status,
      ...(status === "stopped" ? { completedAt: new Date() } : {})
    })
    .returning();
  if (!run) throw new Error("SKILL_RUN_OUTBOX_FIXTURE_FAILED");
  const [outbox] = await db
    .insert(schema.skillRunOutbox)
    .values({ skillRunId: run.id })
    .returning();
  if (!outbox) throw new Error("SKILL_RUN_OUTBOX_FIXTURE_FAILED");
  return { db, organizationId, runId: run.id, outboxId: outbox.id };
}

afterAll(async () => closeDatabase());

describe("skill run outbox", () => {
  test("keeps a queued SkillRun pending after broker failure and safely dispatches it later", async () => {
    const value = await fixture();
    try {
      await expect(
        dispatchPendingSkillRunOutbox(new ControlledQueue(true), 1, 30_000, value.runId)
      ).resolves.toEqual({
        dispatched: 0,
        failed: 1
      });
      const [pending] = await value.db
        .select()
        .from(schema.skillRunOutbox)
        .where(eq(schema.skillRunOutbox.id, value.outboxId));
      expect(pending).toMatchObject({
        status: "pending",
        attemptCount: 1,
        lastErrorCode: "SKILL_RUN_QUEUE_PUBLISH_FAILED"
      });
      const queue = new ControlledQueue(false);
      await expect(dispatchPendingSkillRunOutbox(queue, 1, 30_000, value.runId)).resolves.toEqual({
        dispatched: 1,
        failed: 0
      });
      const [sent] = await value.db
        .select()
        .from(schema.skillRunOutbox)
        .where(eq(schema.skillRunOutbox.id, value.outboxId));
      expect(sent).toMatchObject({
        status: "sent",
        attemptCount: 2,
        queueJobId: expect.any(String)
      });
      expect(queue.published).toEqual([value.runId]);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("discards an outbox row when the SkillRun is already terminal", async () => {
    const value = await fixture("stopped");
    try {
      const queue = new ControlledQueue(false);
      await expect(dispatchPendingSkillRunOutbox(queue, 1, 30_000, value.runId)).resolves.toEqual({
        dispatched: 0,
        failed: 0
      });
      const [outbox] = await value.db
        .select()
        .from(schema.skillRunOutbox)
        .where(eq(schema.skillRunOutbox.id, value.outboxId));
      expect(outbox?.status).toBe("discarded");
      expect(queue.published).toEqual([]);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });
});
