import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import { recoverExpiredProcessingJobs, type JobQueue } from "../src/index";

const test = process.env.DATABASE_URL ? it : it.skip;

class RecoveryQueue implements Pick<JobQueue, "publish"> {
  readonly published: Array<{ jobId: string; resourceVersionId: string }> = [];

  async publish(
    _name: "resource.process",
    payload: { jobId: string; resourceVersionId: string }
  ): Promise<string> {
    this.published.push(payload);
    return randomUUID();
  }
}

async function fixture() {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const resourceId = randomUUID();
  const versionId = randomUUID();
  const jobId = randomUUID();
  await db.insert(schema.organizations).values({ id: organizationId, name: "崩溃恢复演练组织" });
  await db.insert(schema.users).values({
    id: userId,
    email: `crash-${jobId}@example.com`,
    name: "崩溃恢复演练用户",
    passwordHash: "not-used"
  });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "崩溃恢复演练空间",
    createdBy: userId
  });
  await db.insert(schema.resources).values({
    id: resourceId,
    spaceId,
    name: "crash.md",
    status: "queued",
    createdBy: userId
  });
  await db.insert(schema.resourceVersions).values({
    id: versionId,
    resourceId,
    version: 1,
    originalName: "crash.md",
    mimeType: "text/markdown",
    byteSize: 12,
    sha256: randomUUID().replaceAll("-", ""),
    blobUri: `local://tests/${versionId}/source.md`,
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
  return { db, organizationId, resourceId, versionId, jobId };
}

async function waitForClaim(child: ChildProcess) {
  let stderr = "";
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("CRASH_DRILL_CLAIM_TIMEOUT")), 3_000);
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes("claimed")) finish();
    };
    const onExit = (code: number | null) =>
      finish(new Error(`CRASH_DRILL_CHILD_EXITED:${code ?? "signal"}:${stderr}`));
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function startClaimingChild(jobId: string) {
  const token = randomUUID();
  const databaseModule = path.resolve(import.meta.dirname, "../../database/src/index.ts");
  const script = [
    `import { claimProcessingExecution } from ${JSON.stringify(databaseModule)};`,
    `const claimed = await claimProcessingExecution(${JSON.stringify(jobId)}, ${JSON.stringify(token)}, 1000);`,
    "if (!claimed) process.exit(2);",
    'process.stdout.write("claimed");',
    "setInterval(() => undefined, 1000);"
  ].join("\n");
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

afterAll(async () => closeDatabase());

describe("worker crash recovery drill", () => {
  test("recovers a job after the process holding its execution lease is killed", async () => {
    const value = await fixture();
    const child = startClaimingChild(value.jobId);
    try {
      await waitForClaim(child);
      child.kill("SIGKILL");
      await once(child, "exit");
      await value.db
        .update(schema.processingJobs)
        .set({ executionLeaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.processingJobs.id, value.jobId));

      const queue = new RecoveryQueue();
      await expect(recoverExpiredProcessingJobs(queue, { jobIds: [value.jobId] })).resolves.toEqual(
        {
          requeued: 1,
          cancelled: 0
        }
      );
      expect(queue.published).toEqual([{ jobId: value.jobId, resourceVersionId: value.versionId }]);
      const [job] = await value.db
        .select()
        .from(schema.processingJobs)
        .where(eq(schema.processingJobs.id, value.jobId));
      const [resource] = await value.db
        .select()
        .from(schema.resources)
        .where(eq(schema.resources.id, value.resourceId));
      expect(job).toMatchObject({
        id: value.jobId,
        resourceVersionId: value.versionId,
        status: "queued",
        stage: "queued",
        executionToken: null,
        executionLeaseExpiresAt: null
      });
      expect(resource?.status).toBe("queued");
    } finally {
      if (!child.killed) child.kill("SIGKILL");
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });
});
