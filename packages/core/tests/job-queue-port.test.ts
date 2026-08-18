import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryJobQueuePort, type JobQueuePort } from "../src/job-queue-port";
import { createSqliteJobQueuePort } from "../src/sqlite-job-queue";
import { createPostgresJobQueuePort } from "../src/postgres-job-queue";

// node:sqlite needs the --experimental-sqlite flag before Node 23.4; probe
// synchronously so the sqlite suite is skipped (not silently passed) without it.
const SQLITE_AVAILABLE = (() => {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

function clockAt(startAtMs: number) {
  let current = startAtMs;
  return {
    now() {
      return current;
    },
    advance(ms: number) {
      current += ms;
      return current;
    }
  };
}

type PortClock = ReturnType<typeof clockAt>;
type PortContext = { port: JobQueuePort; clock: PortClock };

interface ContractScenario {
  name: string;
  run(port: JobQueuePort, clock: PortClock): Promise<void>;
}

/**
 * The S4 queue-contract gate: every adapter must satisfy the same semantics —
 * idempotent terminal submissions, exclusive leases, bounded retries with
 * dead-lettering, crash recovery and cancellation.
 */
const scenarios: ContractScenario[] = [
  {
    name: "enqueues jobs and returns queued records",
    async run(port) {
      const job = await port.enqueue({ queue: "wiki.compile", payload: { spaceId: "s1" } });
      expect(job).toMatchObject({
        queue: "wiki.compile",
        state: "queued",
        attempts: 0,
        maxAttempts: 3
      });
      expect(await port.list({ queue: "wiki.compile" })).toHaveLength(1);
    }
  },
  {
    name: "does not duplicate terminal submissions under the same idempotency key",
    async run(port, clock) {
      const first = await port.enqueue({
        queue: "report.export",
        payload: { attemptId: "a1" },
        idempotencyKey: "attempt-a1"
      });
      const claimed = await port.claim({
        queue: "report.export",
        workerId: "w1",
        leaseMs: 1_000,
        now: clock.now()
      });
      expect(claimed?.id).toBe(first.id);
      await port.complete(first.id);
      const replay = await port.enqueue({
        queue: "report.export",
        payload: { attemptId: "a1" },
        idempotencyKey: "attempt-a1"
      });
      expect(replay.id).toBe(first.id);
      expect(replay.state).toBe("completed");
      expect(await port.list({ queue: "report.export" })).toHaveLength(1);
    }
  },
  {
    name: "collapses concurrent duplicates with one open idempotency key",
    async run(port) {
      const first = await port.enqueue({ queue: "q", payload: {}, idempotencyKey: "open-key" });
      const second = await port.enqueue({ queue: "q", payload: {}, idempotencyKey: "open-key" });
      expect(second.id).toBe(first.id);
      expect(await port.list()).toHaveLength(1);
    }
  },
  {
    name: "allows a fresh submission after a keyed job failed",
    async run(port, clock) {
      const first = await port.enqueue({
        queue: "q",
        payload: {},
        idempotencyKey: "retry-key",
        maxAttempts: 1
      });
      await port.claim({ queue: "q", workerId: "w1", leaseMs: 1_000, now: clock.now() });
      await port.fail(first.id, "MODEL_TIMEOUT");
      expect((await port.list())[0]?.state).toBe("failed");
      const fresh = await port.enqueue({ queue: "q", payload: {}, idempotencyKey: "retry-key" });
      expect(fresh.id).not.toBe(first.id);
    }
  },
  {
    name: "grants an exclusive lease to one worker at a time",
    async run(port, clock) {
      await port.enqueue({ queue: "q", payload: {} });
      const first = await port.claim({
        queue: "q",
        workerId: "w1",
        leaseMs: 1_000,
        now: clock.now()
      });
      const second = await port.claim({
        queue: "q",
        workerId: "w2",
        leaseMs: 1_000,
        now: clock.now()
      });
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    }
  },
  {
    name: "completes a job exactly once and rejects terminal mutation",
    async run(port, clock) {
      const job = await port.enqueue({ queue: "q", payload: {} });
      await port.claim({ queue: "q", workerId: "w1", leaseMs: 1_000, now: clock.now() });
      await port.complete(job.id);
      await port.complete(job.id);
      expect((await port.list())[0]?.state).toBe("completed");
      await expect(port.fail(job.id, "LATE_ERROR")).rejects.toThrow("JOB_NOT_ACTIVE");
    }
  },
  {
    name: "cancels only jobs that are still queued",
    async run(port, clock) {
      const active = await port.enqueue({ queue: "q", payload: { n: 1 } });
      const queued = await port.enqueue({ queue: "q", payload: { n: 2 } });
      await port.claim({ queue: "q", workerId: "w1", leaseMs: 5_000, now: clock.now() });
      expect(await port.cancel(active.id)).toBe(false);
      expect(await port.cancel(queued.id)).toBe(true);
      const states = (await port.list()).map((job) => job.state);
      expect(states).toContain("cancelled");
      expect(states).toContain("active");
    }
  },
  {
    name: "retries a failed job until attempts are exhausted",
    async run(port, clock) {
      const job = await port.enqueue({ queue: "q", payload: {}, maxAttempts: 2 });
      for (let round = 1; round <= 2; round += 1) {
        const claimed = await port.claim({
          queue: "q",
          workerId: "w1",
          leaseMs: 1_000,
          now: clock.now()
        });
        expect(claimed?.id).toBe(job.id);
        await port.fail(job.id, "MODEL_TIMEOUT");
      }
      const final = (await port.list())[0]!;
      expect(final).toMatchObject({
        state: "failed",
        attempts: 2,
        maxAttempts: 2,
        lastError: "MODEL_TIMEOUT"
      });
      expect(
        await port.claim({ queue: "q", workerId: "w1", leaseMs: 1_000, now: clock.now() })
      ).toBeNull();
    }
  },
  {
    name: "requeues expired leases and dead-letters exhausted jobs",
    async run(port, clock) {
      const recoverable = await port.enqueue({ queue: "q", payload: {}, maxAttempts: 3 });
      await port.claim({ queue: "q", workerId: "crashed", leaseMs: 500, now: clock.now() });
      clock.advance(600);
      const exhausted = await port.enqueue({ queue: "q", payload: {}, maxAttempts: 1 });
      await port.claim({ queue: "q", workerId: "crashed", leaseMs: 500, now: clock.now() });
      clock.advance(600);
      expect(await port.recoverExpiredLeases(clock.now())).toBe(2);
      const states = new Map((await port.list()).map((job) => [job.id, job.state]));
      expect(states.get(recoverable.id)).toBe("queued");
      expect(states.get(exhausted.id)).toBe("failed");
      const reclaimed = await port.claim({
        queue: "q",
        workerId: "w2",
        leaseMs: 1_000,
        now: clock.now()
      });
      expect(reclaimed?.id).toBe(recoverable.id);
      expect(reclaimed?.attempts).toBe(2);
    }
  },
  {
    name: "leaves unexpired and non-active leases alone",
    async run(port, clock) {
      await port.enqueue({ queue: "q", payload: {} });
      await port.claim({ queue: "q", workerId: "w1", leaseMs: 60_000, now: clock.now() });
      expect(await port.recoverExpiredLeases(clock.now())).toBe(0);
      expect((await port.list())[0]?.state).toBe("active");
    }
  }
];

function describeContract(name: string, make: () => Promise<PortContext | null>) {
  describe(name, () => {
    for (const scenario of scenarios) {
      it(scenario.name, async () => {
        const context = await make();
        if (context === null) return; // runtime-gated (e.g. node:sqlite unavailable)
        await scenario.run(context.port, context.clock);
      });
    }
  });
}

describeContract("job queue port contract (in-memory reference)", async () => {
  const clock = clockAt(1_000);
  return { port: createInMemoryJobQueuePort({ now: clock.now }), clock };
});

describe("job queue port contract (sqlite local profile)", () => {
  const sqliteTest = SQLITE_AVAILABLE ? it : it.skip;
  for (const scenario of scenarios) {
    sqliteTest(scenario.name, async () => {
      const clock = clockAt(1_000);
      const port = await createSqliteJobQueuePort({ now: clock.now });
      await scenario.run(port, clock);
    });
  }
});

describe("job queue port contract (postgres server profile)", () => {
  const postgresTest = process.env.DATABASE_URL ? it : it.skip;
  beforeEach(async () => {
    const { getDatabase } = await import("@wknowledge/database");
    const { sql } = await import("drizzle-orm");
    await getDatabase().execute(sql`TRUNCATE TABLE agent_job_queue`);
  });
  for (const scenario of scenarios) {
    postgresTest(scenario.name, async () => {
      const clock = clockAt(1_000);
      const port = await createPostgresJobQueuePort({ now: clock.now });
      await scenario.run(port, clock);
    });
  }
});
