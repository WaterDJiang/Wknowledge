import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";

const test = process.env.DATABASE_URL ? it : it.skip;
const roots: string[] = [];

async function fixture() {
  const db = getDatabase();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wknowledge-worker-data-"));
  const blobRoot = await mkdtemp(path.join(os.tmpdir(), "wknowledge-worker-blobs-"));
  roots.push(dataRoot, blobRoot);
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const resourceId = randomUUID();
  const versionId = randomUUID();
  const jobId = randomUUID();
  const queue = `test.worker-${randomUUID()}`;
  const blobRelative = `${spaceId}/${resourceId}/${versionId}/source.md`;
  await mkdir(path.join(blobRoot, path.dirname(blobRelative)), { recursive: true });
  await writeFile(path.join(blobRoot, blobRelative), "# 强杀恢复\n\n必须从不可变原件重新处理。");
  await db.insert(schema.organizations).values({ id: organizationId, name: "Worker 强杀演练组织" });
  await db.insert(schema.users).values({
    id: userId,
    email: `worker-full-${jobId}@example.com`,
    name: "Worker 强杀演练用户",
    passwordHash: "not-used"
  });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "Worker 强杀演练空间",
    createdBy: userId
  });
  await db.insert(schema.resources).values({
    id: resourceId,
    spaceId,
    name: "crash-recovery.md",
    status: "queued",
    createdBy: userId
  });
  await db.insert(schema.resourceVersions).values({
    id: versionId,
    resourceId,
    version: 1,
    originalName: "crash-recovery.md",
    mimeType: "text/markdown",
    byteSize: 64,
    sha256: randomUUID().replaceAll("-", ""),
    blobUri: `local://${blobRelative}`,
    compileProfile: "knowledge",
    createdBy: userId
  });
  await db.insert(schema.processingJobs).values({
    id: jobId,
    spaceId,
    resourceVersionId: versionId,
    kind: "resource.process",
    status: "queued",
    stage: "queued"
  });
  return { db, dataRoot, blobRoot, organizationId, spaceId, resourceId, versionId, jobId, queue };
}

function startWorker(input: {
  dataRoot: string;
  blobRoot: string;
  queue: string;
  jobId: string;
  delayAfterClaimMs?: number;
}) {
  return spawn(process.execPath, ["--import", "tsx", "apps/worker/src/index.ts"], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: {
      ...process.env,
      WKNOWLEDGE_DATA_ROOT: input.dataRoot,
      WKNOWLEDGE_BLOB_ROOT: input.blobRoot,
      WKNOWLEDGE_RESOURCE_PROCESS_QUEUE: input.queue,
      WKNOWLEDGE_DISABLE_OUTBOX_DRAIN: "1",
      WKNOWLEDGE_RECOVERY_JOB_ID: input.jobId,
      ...(input.delayAfterClaimMs
        ? { WKNOWLEDGE_TEST_DELAY_AFTER_CLAIM_MS: String(input.delayAfterClaimMs) }
        : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitFor<T>(read: () => Promise<T | null>, label: string): Promise<T> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`WORKER_CRASH_DRILL_TIMEOUT:${label}`);
}

async function stopWorker(worker: ChildProcess) {
  if (worker.exitCode !== null || worker.signalCode) return;
  worker.kill("SIGTERM");
  await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
afterAll(async () => closeDatabase());

describe("full worker crash recovery", () => {
  test("kills a running Worker then restarts it to recover and complete the same resource job", async () => {
    const value = await fixture();
    const boss = new PgBoss(process.env.DATABASE_URL!);
    const first = startWorker({ ...value, delayAfterClaimMs: 5_000 });
    let second: ChildProcess | undefined;
    try {
      await boss.start();
      await boss.createQueue(`${value.queue}.dead-letter`);
      await boss.createQueue(value.queue, { deadLetter: `${value.queue}.dead-letter` });
      const sent = await boss.send(value.queue, {
        jobId: value.jobId,
        resourceVersionId: value.versionId
      });
      expect(sent).toBeTruthy();
      await waitFor(async () => {
        const [job] = await value.db
          .select()
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.id, value.jobId));
        return job?.status === "processing" && job.executionToken ? job : null;
      }, "first-worker-claim");
      first.kill("SIGKILL");
      await new Promise<void>((resolve) => first.once("exit", () => resolve()));
      await value.db
        .update(schema.processingJobs)
        .set({ executionLeaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.processingJobs.id, value.jobId));

      second = startWorker(value);
      const completed = await waitFor(async () => {
        const [job] = await value.db
          .select()
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.id, value.jobId));
        return job?.status === "completed" ? job : null;
      }, "restarted-worker-complete");
      const [resource] = await value.db
        .select()
        .from(schema.resources)
        .where(eq(schema.resources.id, value.resourceId));
      expect(completed).toMatchObject({
        id: value.jobId,
        resourceVersionId: value.versionId,
        stage: "completed",
        executionToken: null,
        executionLeaseExpiresAt: null
      });
      expect(resource?.status).toBe("ready");
      await expect(
        readFile(
          path.join(value.dataRoot, value.spaceId, "compiled", value.versionId, "content.md"),
          "utf8"
        )
      ).resolves.toContain("必须从不可变原件重新处理");
    } finally {
      await stopWorker(first);
      if (second) await stopWorker(second);
      await boss.deleteQueue(value.queue).catch(() => undefined);
      await boss.deleteQueue(`${value.queue}.dead-letter`).catch(() => undefined);
      await boss.stop();
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  }, 20_000);
});
