import { sql } from "drizzle-orm";
import { getDatabase } from "@wknowledge/database";
import type { JobQueuePort, QueuedJobRecord } from "./job-queue-port";

/**
 * PostgreSQL JobQueue adapter — the server-profile adapter of the JobQueue
 * Port. It deliberately uses the same table shape and semantics as the
 * SQLite local adapter (claim/lease/ms-precision, same contract suite), not
 * pg-boss: existing pg-boss jobs keep running unchanged until the M7-13
 * migration moves them onto this port. Server and local profiles therefore
 * pass literally the same queue contract tests.
 */

const DEFAULT_MAX_ATTEMPTS = 3;

function queueError(code: string): never {
  throw new Error(code);
}

function isTerminal(state: string): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

type JobRow = {
  id: string;
  queue: string;
  payload: string;
  state: string;
  attempts: number | string;
  max_attempts: number | string;
  leased_until: number | string | null;
  last_error: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
};

function toRecord(row: JobRow): QueuedJobRecord {
  return {
    id: row.id,
    queue: row.queue,
    payload: JSON.parse(row.payload) as unknown,
    state: row.state as QueuedJobRecord["state"],
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leasedUntil: row.leased_until === null ? null : Number(row.leased_until),
    lastError: row.last_error,
    idempotencyKey: row.idempotency_key,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function createPostgresJobQueuePort(input?: {
  now?: () => number;
}): Promise<JobQueuePort> {
  const db = getDatabase();
  const now = input?.now ?? (() => Date.now());
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_job_queue (
      seq BIGSERIAL PRIMARY KEY,
      id TEXT NOT NULL UNIQUE GENERATED ALWAYS AS ('job-' || lpad(seq::text, 8, '0')) STORED,
      queue TEXT NOT NULL,
      payload TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      leased_until BIGINT,
      last_error TEXT,
      idempotency_key TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS agent_job_queue_claim_idx ON agent_job_queue (queue, state, seq)
  `);
  let sequence = 0;

  return {
    async enqueue(jobInput) {
      if (typeof jobInput.queue !== "string" || jobInput.queue.length === 0) {
        queueError("JOB_QUEUE_INVALID");
      }
      const maxAttempts = jobInput.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
        queueError("JOB_ATTEMPTS_INVALID");
      }
      const key = jobInput.idempotencyKey ?? null;
      if (key !== null) {
        const existing = await db.execute<JobRow>(sql`
          SELECT * FROM agent_job_queue
          WHERE queue = ${jobInput.queue} AND idempotency_key = ${key}
          ORDER BY seq DESC LIMIT 1
        `);
        const row = existing.rows[0];
        if (row) {
          const record = toRecord(row);
          if (!isTerminal(record.state) || record.state === "completed") return record;
        }
      }
      sequence += 1;
      void sequence;
      const stamp = new Date(now()).toISOString();
      await db.execute(sql`
        INSERT INTO agent_job_queue
          (queue, payload, state, attempts, max_attempts, idempotency_key, created_at, updated_at)
        VALUES (${jobInput.queue}, ${JSON.stringify(jobInput.payload ?? null)}, 'queued', 0, ${maxAttempts}, ${key}, ${stamp}, ${stamp})
      `);
      const inserted = await db.execute<JobRow>(sql`
        SELECT * FROM agent_job_queue WHERE idempotency_key = ${key} OR id = (
          SELECT 'job-' || lpad(seq::text, 8, '0') FROM agent_job_queue ORDER BY seq DESC LIMIT 1
        ) ORDER BY seq DESC LIMIT 1
      `);
      return toRecord(inserted.rows[0] as JobRow);
    },

    async claim(claimInput) {
      if (!Number.isInteger(claimInput.leaseMs) || claimInput.leaseMs <= 0) {
        queueError("JOB_LEASE_INVALID");
      }
      const current = claimInput.now !== undefined ? claimInput.now : now();
      const claimed = await db.execute<JobRow>(sql`
        UPDATE agent_job_queue
        SET state = 'active', attempts = attempts + 1,
            leased_until = ${current + claimInput.leaseMs}, updated_at = ${new Date(current).toISOString()}
        WHERE id = (
          SELECT id FROM agent_job_queue WHERE queue = ${claimInput.queue} AND state = 'queued' ORDER BY seq LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `);
      const row = claimed.rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async complete(jobId) {
      const existing = await db.execute<JobRow>(
        sql`SELECT * FROM agent_job_queue WHERE id = ${jobId}`
      );
      const row = existing.rows[0];
      if (!row) queueError("JOB_NOT_FOUND");
      const record = toRecord(row as JobRow);
      if (record.state === "completed") return;
      if (record.state !== "active") queueError("JOB_NOT_ACTIVE");
      await db.execute(sql`
        UPDATE agent_job_queue
        SET state = 'completed', leased_until = NULL, last_error = NULL, updated_at = ${new Date(now()).toISOString()}
        WHERE id = ${jobId}
      `);
    },

    async fail(jobId, error) {
      const existing = await db.execute<JobRow>(
        sql`SELECT * FROM agent_job_queue WHERE id = ${jobId}`
      );
      const row = existing.rows[0];
      if (!row) queueError("JOB_NOT_FOUND");
      const record = toRecord(row as JobRow);
      if (record.state === "failed") return;
      if (record.state !== "active") queueError("JOB_NOT_ACTIVE");
      await db.execute(sql`
        UPDATE agent_job_queue
        SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
            leased_until = NULL, last_error = ${error}, updated_at = ${new Date(now()).toISOString()}
        WHERE id = ${jobId}
      `);
    },

    async cancel(jobId) {
      const cancelled = await db.execute<JobRow>(sql`
        UPDATE agent_job_queue SET state = 'cancelled', updated_at = ${new Date(now()).toISOString()}
        WHERE id = ${jobId} AND state = 'queued' RETURNING *
      `);
      return cancelled.rows.length > 0;
    },

    async recoverExpiredLeases(recoverAt) {
      const recovered = await db.execute<JobRow>(sql`
        UPDATE agent_job_queue
        SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
            leased_until = NULL, last_error = 'JOB_LEASE_EXPIRED', updated_at = ${new Date(recoverAt).toISOString()}
        WHERE state = 'active' AND leased_until IS NOT NULL AND leased_until <= ${recoverAt}
        RETURNING *
      `);
      return recovered.rows.length;
    },

    async list(filter) {
      const rows =
        filter?.queue !== undefined
          ? await db.execute<JobRow>(
              sql`SELECT * FROM agent_job_queue WHERE queue = ${filter.queue} ORDER BY id`
            )
          : await db.execute<JobRow>(sql`SELECT * FROM agent_job_queue ORDER BY id`);
      return rows.rows.map((row) => toRecord(row as JobRow));
    }
  };
}
