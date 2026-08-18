import type { JobQueuePort, QueuedJobRecord } from "./job-queue-port";

/**
 * SQLite-backed local JobQueue adapter (M7-12, upgrade spec §7) on the
 * built-in `node:sqlite` module — zero third-party dependencies for the
 * local runtime profile. The module is experimental upstream (needs
 * Node >= 22.5 and, before 23.4, the --experimental-sqlite flag), so the
 * import is dynamic and availability-gated. Semantics are identical to the
 * in-memory reference adapter and held to the same contract suite.
 */

interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS agent_job_queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  queue TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  leased_until INTEGER,
  last_error TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_job_queue_claim_idx
  ON agent_job_queue (queue, state, seq);
`;

const DEFAULT_MAX_ATTEMPTS = 3;

function queueError(code: string): never {
  throw new Error(code);
}

function isTerminal(state: string): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function toRecord(row: Record<string, unknown>): QueuedJobRecord {
  return {
    id: String(row.id),
    queue: String(row.queue),
    payload: JSON.parse(String(row.payload)) as unknown,
    state: String(row.state) as QueuedJobRecord["state"],
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leasedUntil: row.leased_until === null ? null : Number(row.leased_until),
    lastError: row.last_error === null ? null : String(row.last_error),
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export async function createSqliteJobQueuePort(input?: {
  databasePath?: string;
  now?: () => number;
}): Promise<JobQueuePort> {
  const sqlite = await import("node:sqlite").catch(() => {
    throw new Error("SQLITE_RUNTIME_UNAVAILABLE");
  });
  const database = new (
    sqlite as unknown as { DatabaseSync: new (path: string) => SqliteDatabase }
  ).DatabaseSync(input?.databasePath ?? ":memory:") as SqliteDatabase;
  database.exec(CREATE_TABLE);
  const now = input?.now ?? (() => Date.now());
  let sequence = 0;

  const byId = database.prepare("SELECT * FROM agent_job_queue WHERE id = ?");
  const byIdempotencyKey = database.prepare(
    "SELECT * FROM agent_job_queue WHERE queue = ? AND idempotency_key = ? ORDER BY seq DESC LIMIT 1"
  );
  const insert = database.prepare(
    `INSERT INTO agent_job_queue
       (id, queue, payload, state, attempts, max_attempts, leased_until, last_error, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 0, ?, NULL, NULL, ?, ?, ?)`
  );
  const claimJob = database.prepare(
    `UPDATE agent_job_queue
     SET state = 'active', attempts = attempts + 1, leased_until = ?, updated_at = ?
     WHERE id = (
       SELECT id FROM agent_job_queue WHERE queue = ? AND state = 'queued' ORDER BY seq LIMIT 1
     )
     RETURNING *`
  );
  const completeJob = database.prepare(
    `UPDATE agent_job_queue
     SET state = 'completed', leased_until = NULL, last_error = NULL, updated_at = ?
     WHERE id = ? RETURNING *`
  );
  const failJob = database.prepare(
    `UPDATE agent_job_queue
     SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         leased_until = NULL, last_error = ?, updated_at = ?
     WHERE id = ? RETURNING *`
  );
  const cancelJob = database.prepare(
    `UPDATE agent_job_queue SET state = 'cancelled', updated_at = ?
     WHERE id = ? AND state = 'queued' RETURNING *`
  );
  const recoverJob = database.prepare(
    `UPDATE agent_job_queue
     SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
         leased_until = NULL, last_error = 'JOB_LEASE_EXPIRED', updated_at = ?
     WHERE state = 'active' AND leased_until IS NOT NULL AND leased_until <= ?
     RETURNING *`
  );
  const listAll = database.prepare("SELECT * FROM agent_job_queue ORDER BY id");
  const listByQueue = database.prepare("SELECT * FROM agent_job_queue WHERE queue = ? ORDER BY id");

  function rowToRecord(row: unknown): QueuedJobRecord {
    return toRecord(row as Record<string, unknown>);
  }

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
        const existing = byIdempotencyKey.get(jobInput.queue, key);
        if (existing) {
          const record = rowToRecord(existing);
          if (!isTerminal(record.state) || record.state === "completed") return record;
        }
      }
      sequence += 1;
      const id = `job-${sequence.toString().padStart(8, "0")}`;
      const stamp = new Date(now()).toISOString();
      insert.run(
        id,
        jobInput.queue,
        JSON.stringify(jobInput.payload ?? null),
        maxAttempts,
        key,
        stamp,
        stamp
      );
      return rowToRecord(byId.get(id));
    },

    async claim(claimInput) {
      if (!Number.isInteger(claimInput.leaseMs) || claimInput.leaseMs <= 0) {
        queueError("JOB_LEASE_INVALID");
      }
      const current = claimInput.now !== undefined ? claimInput.now : now();
      const row = claimJob.all(
        current + claimInput.leaseMs,
        new Date(current).toISOString(),
        claimInput.queue
      )[0];
      return row === undefined ? null : rowToRecord(row);
    },

    async complete(jobId) {
      const existing = byId.get(jobId);
      if (!existing) queueError("JOB_NOT_FOUND");
      const record = rowToRecord(existing);
      if (record.state === "completed") return;
      if (record.state !== "active") queueError("JOB_NOT_ACTIVE");
      completeJob.run(new Date(now()).toISOString(), jobId);
    },

    async fail(jobId, error) {
      const existing = byId.get(jobId);
      if (!existing) queueError("JOB_NOT_FOUND");
      const record = rowToRecord(existing);
      if (record.state === "failed") return;
      if (record.state !== "active") queueError("JOB_NOT_ACTIVE");
      failJob.run(error, new Date(now()).toISOString(), jobId);
    },

    async cancel(jobId) {
      const existing = byId.get(jobId);
      if (!existing) queueError("JOB_NOT_FOUND");
      const rows = cancelJob.all(new Date(now()).toISOString(), jobId);
      return rows.length > 0;
    },

    async recoverExpiredLeases(recoverAt) {
      const rows = recoverJob.all(new Date(recoverAt).toISOString(), recoverAt);
      return rows.length;
    },

    async list(filter) {
      const rows = filter?.queue !== undefined ? listByQueue.all(filter.queue) : listAll.all();
      return rows.map(rowToRecord);
    }
  };
}
