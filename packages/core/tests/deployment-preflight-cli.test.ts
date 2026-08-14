import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const preflightCli = path.resolve(process.cwd(), "deploy", "preflight.mjs");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wknowledge-preflight-"));
  roots.push(root);
  const dataRoot = path.join(root, "spaces");
  const blobRoot = path.join(root, "blobs");
  await Promise.all([mkdir(dataRoot), mkdir(blobRoot)]);
  return { root, dataRoot, blobRoot };
}

function environment(
  value: { dataRoot: string; blobRoot: string },
  overrides: NodeJS.ProcessEnv = {}
) {
  return {
    ...process.env,
    DATABASE_URL: "postgresql://operator:private-password@postgres:5432/wknowledge",
    POSTGRES_PASSWORD: "private-password",
    WKNOWLEDGE_RELEASE_VERSION: "0.1.0",
    WKNOWLEDGE_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64url"),
    WKNOWLEDGE_DATA_ROOT: value.dataRoot,
    WKNOWLEDGE_BLOB_ROOT: value.blobRoot,
    WKNOWLEDGE_MIN_FREE_BYTES: "1",
    ...overrides
  };
}

async function run(value: { dataRoot: string; blobRoot: string }, overrides?: NodeJS.ProcessEnv) {
  return execFileAsync(process.execPath, [preflightCli], { env: environment(value, overrides) });
}

describe("deployment preflight CLI", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("accepts isolated managed roots and emits no sensitive configuration", async () => {
    const value = await fixture();
    const result = await run(value);

    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      checks: ["database_url", "release_version", "credential_key", "storage_roots", "capacity"]
    });
    expect(result.stdout).not.toContain(value.root);
    expect(result.stdout).not.toContain("private-password");
    expect(result.stdout).not.toContain(process.env.WKNOWLEDGE_CREDENTIAL_KEY ?? "__not_present__");
  });

  it("rejects default passwords, invalid credentials and overlapping roots without writing files", async () => {
    const value = await fixture();

    await expect(run(value, { POSTGRES_PASSWORD: "wknowledge" })).rejects.toMatchObject({
      stderr: "PREFLIGHT_POSTGRES_PASSWORD_INVALID\n"
    });
    await expect(run(value, { WKNOWLEDGE_CREDENTIAL_KEY: "too-short" })).rejects.toMatchObject({
      stderr: "PREFLIGHT_CREDENTIAL_KEY_INVALID\n"
    });
    await expect(run(value, { WKNOWLEDGE_BLOB_ROOT: value.dataRoot })).rejects.toMatchObject({
      stderr: "PREFLIGHT_STORAGE_ROOTS_OVERLAP\n"
    });
  });

  it("fails closed when the requested free capacity cannot be met", async () => {
    const value = await fixture();

    await expect(
      run(value, { WKNOWLEDGE_MIN_FREE_BYTES: "999999999999999999999999999999" })
    ).rejects.toMatchObject({ stderr: "PREFLIGHT_CAPACITY_INSUFFICIENT\n" });
  });
});
