import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, lt, or } from "drizzle-orm";
import { getDatabase, schema } from "@wknowledge/database";

export interface SkillRunOutboxQueue {
  publish(name: "skill.run", payload: { skillRunId: string }): Promise<string>;
}

const DEFAULT_SKILL_RUN_OUTBOX_LEASE_MS = 30_000;

function dispatchableCondition(now: Date) {
  return or(
    eq(schema.skillRunOutbox.status, "pending"),
    and(
      eq(schema.skillRunOutbox.status, "dispatching"),
      isNotNull(schema.skillRunOutbox.dispatchLeaseExpiresAt),
      lt(schema.skillRunOutbox.dispatchLeaseExpiresAt, now)
    )
  );
}

export async function dispatchPendingSkillRunOutbox(
  queue: SkillRunOutboxQueue,
  limit = 25,
  leaseMs = DEFAULT_SKILL_RUN_OUTBOX_LEASE_MS,
  skillRunId?: string
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("SKILL_RUN_OUTBOX_LIMIT_INVALID");
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000)
    throw new Error("SKILL_RUN_OUTBOX_LEASE_INVALID");
  const db = getDatabase();
  let dispatched = 0;
  let failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const now = new Date();
    const [candidate] = await db
      .select()
      .from(schema.skillRunOutbox)
      .where(
        and(
          dispatchableCondition(now),
          ...(skillRunId ? [eq(schema.skillRunOutbox.skillRunId, skillRunId)] : [])
        )
      )
      .orderBy(schema.skillRunOutbox.createdAt)
      .limit(1);
    if (!candidate) break;
    const token = randomUUID();
    const [claimed] = await db
      .update(schema.skillRunOutbox)
      .set({
        status: "dispatching",
        attemptCount: candidate.attemptCount + 1,
        dispatchToken: token,
        dispatchLeaseExpiresAt: new Date(Date.now() + leaseMs),
        updatedAt: now
      })
      .where(
        and(
          eq(schema.skillRunOutbox.id, candidate.id),
          dispatchableCondition(now),
          ...(skillRunId ? [eq(schema.skillRunOutbox.skillRunId, skillRunId)] : [])
        )
      )
      .returning();
    if (!claimed) continue;
    const [run] = await db
      .select({ id: schema.skillRuns.id, status: schema.skillRuns.status })
      .from(schema.skillRuns)
      .where(eq(schema.skillRuns.id, claimed.skillRunId))
      .limit(1);
    if (!run || run.status !== "queued") {
      await db
        .update(schema.skillRunOutbox)
        .set({
          status: "discarded",
          dispatchToken: null,
          dispatchLeaseExpiresAt: null,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(schema.skillRunOutbox.id, claimed.id),
            eq(schema.skillRunOutbox.status, "dispatching"),
            eq(schema.skillRunOutbox.dispatchToken, token)
          )
        );
      continue;
    }
    try {
      const queueJobId = await queue.publish("skill.run", { skillRunId: run.id });
      const [sent] = await db
        .update(schema.skillRunOutbox)
        .set({
          status: "sent",
          queueJobId,
          sentAt: new Date(),
          dispatchToken: null,
          dispatchLeaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorAt: null,
          updatedAt: new Date()
        })
        .where(
          and(
            eq(schema.skillRunOutbox.id, claimed.id),
            eq(schema.skillRunOutbox.status, "dispatching"),
            eq(schema.skillRunOutbox.dispatchToken, token)
          )
        )
        .returning({ id: schema.skillRunOutbox.id });
      if (sent) dispatched += 1;
    } catch {
      await db
        .update(schema.skillRunOutbox)
        .set({
          status: "pending",
          dispatchToken: null,
          dispatchLeaseExpiresAt: null,
          lastErrorCode: "SKILL_RUN_QUEUE_PUBLISH_FAILED",
          lastErrorAt: new Date(),
          updatedAt: new Date()
        })
        .where(
          and(
            eq(schema.skillRunOutbox.id, claimed.id),
            eq(schema.skillRunOutbox.status, "dispatching"),
            eq(schema.skillRunOutbox.dispatchToken, token)
          )
        );
      failed += 1;
      break;
    }
  }
  return { dispatched, failed };
}
