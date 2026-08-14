import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeDatabase,
  consumeRequestRateLimit,
  consumeRequestRateLimits,
  getDatabase,
  schema
} from "../src/index";

const test = process.env.DATABASE_URL ? it : it.skip;

afterAll(async () => closeDatabase());

describe("request rate limits", () => {
  test("counts with a hashed key and releases a new time window", async () => {
    const subject = `user-${randomUUID()}`;
    const first = await consumeRequestRateLimit({
      scope: "test.request-rate-limit",
      subject,
      limit: 2,
      windowSeconds: 1
    });
    const second = await consumeRequestRateLimit({
      scope: "test.request-rate-limit",
      subject,
      limit: 2,
      windowSeconds: 1
    });
    const third = await consumeRequestRateLimit({
      scope: "test.request-rate-limit",
      subject,
      limit: 2,
      windowSeconds: 1
    });
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third).toMatchObject({ allowed: false, retryAfterSeconds: expect.any(Number) });

    const records = await getDatabase().select().from(schema.requestRateLimits);
    const record = records.find((item) => item.key.length === 64 && item.count === 3);
    expect(record).toBeDefined();
    expect(JSON.stringify(records)).not.toContain(subject);
  });

  test("rolls back every key when one combined budget is exhausted", async () => {
    const firstSubject = `organization-${randomUUID()}`;
    const exhaustedSubject = `provider-${randomUUID()}`;
    const entries = [
      { scope: "test.atomic.organization", subject: firstSubject, limit: 2, windowSeconds: 60 },
      { scope: "test.atomic.provider", subject: exhaustedSubject, limit: 1, windowSeconds: 60 }
    ];
    expect(await consumeRequestRateLimits(entries)).toMatchObject({ allowed: true });
    expect(await consumeRequestRateLimits(entries)).toMatchObject({
      allowed: false,
      deniedScope: "test.atomic.provider"
    });
    expect(
      await consumeRequestRateLimit({
        scope: "test.atomic.organization",
        subject: firstSubject,
        limit: 2,
        windowSeconds: 60
      })
    ).toMatchObject({ allowed: true });
  });
});
