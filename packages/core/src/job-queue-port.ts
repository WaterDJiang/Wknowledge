/**
 * JobQueue Port and the in-process local adapter (M7-12, upgrade spec §7).
 *
 * Domain components enqueue work through this port only; the server profile
 * maps it onto pg-boss and the local profile onto SQLite. The in-memory
 * adapter below fixes the contract semantics — idempotent terminal states,
 * exclusive claims with leases, crash recovery and bounded retries — so both
 * real adapters can be held to the same behaviour with the same tests.
 */

export type QueuedJobState = "queued" | "active" | "completed" | "failed" | "cancelled";

export interface QueuedJobRecord {
  id: string;
  queue: string;
  payload: unknown;
  state: QueuedJobState;
  attempts: number;
  maxAttempts: number;
  leasedUntil: number | null;
  lastError: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobQueuePort {
  enqueue(input: {
    queue: string;
    payload: unknown;
    idempotencyKey?: string;
    maxAttempts?: number;
  }): Promise<QueuedJobRecord>;
  claim(input: {
    queue: string;
    workerId: string;
    leaseMs: number;
    now?: number;
  }): Promise<QueuedJobRecord | null>;
  complete(jobId: string): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
  cancel(jobId: string): Promise<boolean>;
  recoverExpiredLeases(now: number): Promise<number>;
  list(input?: { queue?: string }): Promise<QueuedJobRecord[]>;
}

const DEFAULT_MAX_ATTEMPTS = 3;

function jobError(code: string): never {
  throw new Error(code);
}

function isTerminal(job: QueuedJobRecord): boolean {
  return job.state === "completed" || job.state === "failed" || job.state === "cancelled";
}

/**
 * Local in-memory JobQueue adapter. Suitable for tests, the future SQLite
 * profile's semantic reference, and single-process local runs; not for
 * multi-worker server deployments.
 */
export function createInMemoryJobQueuePort(input?: { now?: () => number }): JobQueuePort {
  const jobs = new Map<string, QueuedJobRecord>();
  const byIdempotencyKey = new Map<string, string>();
  let sequence = 0;
  const now = input?.now ?? (() => Date.now());

  function stamp(id: string, patch: (job: QueuedJobRecord) => QueuedJobRecord): QueuedJobRecord {
    const current = jobs.get(id);
    if (!current) jobError("JOB_NOT_FOUND");
    const updated = { ...patch(current), updatedAt: new Date(now()).toISOString() };
    jobs.set(id, updated);
    return updated;
  }

  return {
    async enqueue(input) {
      if (typeof input.queue !== "string" || input.queue.length === 0) {
        jobError("JOB_QUEUE_INVALID");
      }
      const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
        jobError("JOB_ATTEMPTS_INVALID");
      }
      const key = input.idempotencyKey ?? null;
      if (key !== null) {
        const existingId = byIdempotencyKey.get(`${input.queue}::${key}`);
        const existing = existingId !== undefined ? jobs.get(existingId) : undefined;
        if (existing && !isTerminal(existing)) return existing;
        if (existing && existing.state === "completed") return existing;
        // A failed/cancelled job with the same key may be re-enqueued as a new job.
      }
      sequence += 1;
      const id = `job-${sequence.toString().padStart(8, "0")}`;
      const record: QueuedJobRecord = {
        id,
        queue: input.queue,
        payload: input.payload,
        state: "queued",
        attempts: 0,
        maxAttempts,
        leasedUntil: null,
        lastError: null,
        idempotencyKey: key,
        createdAt: new Date(now()).toISOString(),
        updatedAt: new Date(now()).toISOString()
      };
      jobs.set(id, record);
      if (key !== null) byIdempotencyKey.set(`${input.queue}::${key}`, id);
      return record;
    },

    async claim(input) {
      if (!Number.isInteger(input.leaseMs) || input.leaseMs <= 0) {
        jobError("JOB_LEASE_INVALID");
      }
      const current = input.now !== undefined ? input.now : now();
      for (const job of [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (job.queue !== input.queue || job.state !== "queued") continue;
        return stamp(job.id, (jobToClaim) => ({
          ...jobToClaim,
          state: "active",
          attempts: jobToClaim.attempts + 1,
          leasedUntil: current + input.leaseMs
        }));
      }
      return null;
    },

    async complete(jobId) {
      const job = jobs.get(jobId);
      if (!job) jobError("JOB_NOT_FOUND");
      if (job.state === "completed") return;
      if (job.state !== "active") jobError("JOB_NOT_ACTIVE");
      stamp(jobId, (jobToComplete) => ({
        ...jobToComplete,
        state: "completed",
        leasedUntil: null,
        lastError: null
      }));
    },

    async fail(jobId, error) {
      const job = jobs.get(jobId);
      if (!job) jobError("JOB_NOT_FOUND");
      if (job.state === "failed") return;
      if (job.state !== "active") jobError("JOB_NOT_ACTIVE");
      stamp(jobId, (jobToFail) => ({
        ...jobToFail,
        state: jobToFail.attempts >= jobToFail.maxAttempts ? "failed" : "queued",
        leasedUntil: null,
        lastError: error
      }));
    },

    async cancel(jobId) {
      const job = jobs.get(jobId);
      if (!job) jobError("JOB_NOT_FOUND");
      if (job.state !== "queued") return false;
      stamp(jobId, (jobToCancel) => ({ ...jobToCancel, state: "cancelled" }));
      return true;
    },

    async recoverExpiredLeases(recoverAt) {
      let recovered = 0;
      for (const job of [...jobs.values()]) {
        if (job.state !== "active" || job.leasedUntil === null) continue;
        if (job.leasedUntil > recoverAt) continue;
        stamp(job.id, (jobToRecover) => ({
          ...jobToRecover,
          state: jobToRecover.attempts >= jobToRecover.maxAttempts ? "failed" : "queued",
          leasedUntil: null,
          lastError: "JOB_LEASE_EXPIRED"
        }));
        recovered += 1;
      }
      return recovered;
    },

    async list(filter) {
      return [...jobs.values()]
        .filter((job) => (filter?.queue !== undefined ? job.queue === filter.queue : true))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
  };
}
