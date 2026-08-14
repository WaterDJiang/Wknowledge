import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { PgBossJobQueue } from "../src/index";

const enabled = Boolean(process.env.DATABASE_URL);
const test = enabled ? it : it.skip;

describe("pg-boss job queue", () => {
  test("persists a queue id that can be cancelled and resumed", async () => {
    const queue = new PgBossJobQueue(process.env.DATABASE_URL!);
    const resourceVersionId = randomUUID();
    const queueJobId = await queue.publish("resource.process", {
      jobId: randomUUID(),
      resourceVersionId
    });
    const inspector = new PgBoss(process.env.DATABASE_URL!);
    try {
      expect(queueJobId).toMatch(/^[0-9a-f-]{36}$/);
      await inspector.start();
      expect((await inspector.getQueue("resource.process"))?.deadLetter).toBe(
        "resource.process.dead-letter"
      );
      expect(await queue.cancel("resource.process", queueJobId)).toBe(true);
      expect(await queue.resume("resource.process", queueJobId)).toBe(true);
      expect(await queue.cancel("resource.process", queueJobId)).toBe(true);
    } finally {
      await inspector.stop();
      await queue.stop();
    }
  });
});
