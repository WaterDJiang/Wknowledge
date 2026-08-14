import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";
import { readResourceQueueHealth, redriveResourceDeadLetters } from "../src/index";

const test = process.env.DATABASE_URL ? it : it.skip;

describe("dead-letter operations", () => {
  test("reports only resource processing dead letters and redrives a bounded batch", async () => {
    const boss = new PgBoss(process.env.DATABASE_URL!);
    await boss.start();
    const queue = `test.resource-${randomUUID()}`;
    const deadLetter = `${queue}.dead-letter`;
    const otherQueue = `test.other-${randomUUID()}`;
    const otherDeadLetter = `${otherQueue}.dead-letter`;
    try {
      await boss.createQueue(deadLetter);
      await boss.createQueue(queue, { deadLetter });
      await boss.updateQueue(queue, { deadLetter });
      await boss.createQueue(otherDeadLetter);
      await boss.createQueue(otherQueue, { deadLetter: otherDeadLetter });
      const resourceId = await boss.send(
        queue,
        { jobId: randomUUID(), resourceVersionId: randomUUID() },
        { retryLimit: 0 }
      );
      const otherId = await boss.send(otherQueue, { secret: "must-not-return" }, { retryLimit: 0 });
      const [resourceJob] = await boss.fetch(queue, { includeMetadata: true });
      const [otherJob] = await boss.fetch(otherQueue, { includeMetadata: true });
      await boss.fail(queue, resourceJob!.id, { reason: "test" });
      await boss.fail(otherQueue, otherJob!.id, { reason: "test" });

      const health = await readResourceQueueHealth(process.env.DATABASE_URL!, {
        processingQueue: queue,
        deadLetterQueue: deadLetter
      });
      expect(health.jobs).toEqual([expect.objectContaining({ sourceName: queue, retryCount: 0 })]);
      expect(JSON.stringify(health)).not.toContain("secret");
      expect(JSON.stringify(health)).not.toContain(otherId!);

      expect(
        await redriveResourceDeadLetters(process.env.DATABASE_URL!, 1, {
          processingQueue: queue,
          deadLetterQueue: deadLetter
        })
      ).toBe(1);
      expect(
        (await boss.findJobs(deadLetter, { queued: true })).filter(
          (job) => job.sourceName === queue
        )
      ).toHaveLength(0);
      expect(
        (await boss.findJobs(otherDeadLetter, { queued: true })).filter(
          (job) => job.sourceName === otherQueue
        )
      ).toHaveLength(1);
      expect(resourceId).toBeTruthy();
      expect(otherId).toBeTruthy();
    } finally {
      await boss.deleteQueue(queue);
      await boss.deleteQueue(deadLetter);
      await boss.deleteQueue(otherQueue);
      await boss.deleteQueue(otherDeadLetter);
      await boss.stop();
    }
  });
});
