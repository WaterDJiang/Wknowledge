import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDatabase } from "./index";

export interface RequestRateLimitInput {
  scope: string;
  subject: string;
  limit: number;
  windowSeconds: number;
}

export interface RequestRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface RequestRateLimitBatchResult {
  allowed: boolean;
  retryAfterSeconds: number;
  deniedScope?: string;
}

function hashedKey(scope: string, subject: string): string {
  return createHash("sha256").update(`${scope}:${subject}`).digest("hex");
}

export async function consumeRequestRateLimits(
  inputs: readonly RequestRateLimitInput[]
): Promise<RequestRateLimitBatchResult> {
  if (inputs.length === 0 || inputs.length > 16) throw new Error("RATE_LIMIT_INVALID");
  const keys = new Set<string>();
  for (const input of inputs) {
    if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error("RATE_LIMIT_INVALID");
    if (!Number.isInteger(input.windowSeconds) || input.windowSeconds < 1)
      throw new Error("RATE_LIMIT_INVALID");
    const key = hashedKey(input.scope, input.subject);
    if (keys.has(key)) throw new Error("RATE_LIMIT_INVALID");
    keys.add(key);
  }

  class RateLimitExceeded extends Error {
    constructor(
      readonly retryAfterSeconds: number,
      readonly scope: string
    ) {
      super("RATE_LIMIT_EXCEEDED");
    }
  }

  try {
    await getDatabase().transaction(async (transaction) => {
      for (const input of inputs) {
        const key = hashedKey(input.scope, input.subject);
        const result = await transaction.execute(
          sql<{ count: number; retry_after_seconds: number }>`
            INSERT INTO request_rate_limit (key, window_started_at, count, updated_at)
            VALUES (${key}, now(), 1, now())
            ON CONFLICT (key) DO UPDATE
            SET
              count = CASE
                WHEN request_rate_limit.window_started_at <= now() - (${input.windowSeconds} * interval '1 second')
                  THEN 1
                ELSE request_rate_limit.count + 1
              END,
              window_started_at = CASE
                WHEN request_rate_limit.window_started_at <= now() - (${input.windowSeconds} * interval '1 second')
                  THEN now()
                ELSE request_rate_limit.window_started_at
              END,
              updated_at = now()
            RETURNING
              count,
              GREATEST(
                1,
                CEIL(EXTRACT(EPOCH FROM (window_started_at + (${input.windowSeconds} * interval '1 second') - now())))
              )::int AS retry_after_seconds
          `
        );
        const row = result.rows[0];
        if (!row) throw new Error("RATE_LIMIT_WRITE_FAILED");
        if (Number(row.count) > input.limit)
          throw new RateLimitExceeded(Number(row.retry_after_seconds), input.scope);
      }
    });
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (error) {
    if (error instanceof RateLimitExceeded)
      return {
        allowed: false,
        retryAfterSeconds: error.retryAfterSeconds,
        deniedScope: error.scope
      };
    throw error;
  }
}

export async function consumeRequestRateLimit(
  input: RequestRateLimitInput
): Promise<RequestRateLimitResult> {
  if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error("RATE_LIMIT_INVALID");
  if (!Number.isInteger(input.windowSeconds) || input.windowSeconds < 1)
    throw new Error("RATE_LIMIT_INVALID");

  const key = hashedKey(input.scope, input.subject);
  const result = await getDatabase().execute(sql<{ count: number; retry_after_seconds: number }>`
    INSERT INTO request_rate_limit (key, window_started_at, count, updated_at)
    VALUES (${key}, now(), 1, now())
    ON CONFLICT (key) DO UPDATE
    SET
      count = CASE
        WHEN request_rate_limit.window_started_at <= now() - (${input.windowSeconds} * interval '1 second')
          THEN 1
        ELSE request_rate_limit.count + 1
      END,
      window_started_at = CASE
        WHEN request_rate_limit.window_started_at <= now() - (${input.windowSeconds} * interval '1 second')
          THEN now()
        ELSE request_rate_limit.window_started_at
      END,
      updated_at = now()
    RETURNING
      count,
      GREATEST(
        1,
        CEIL(EXTRACT(EPOCH FROM (window_started_at + (${input.windowSeconds} * interval '1 second') - now())))
      )::int AS retry_after_seconds
  `);
  const row = result.rows[0];
  if (!row) throw new Error("RATE_LIMIT_WRITE_FAILED");
  return {
    allowed: Number(row.count) <= input.limit,
    retryAfterSeconds: Number(row.retry_after_seconds)
  };
}
