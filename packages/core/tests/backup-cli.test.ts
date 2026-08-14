import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const backupCli = path.resolve(process.cwd(), "deploy", "backup.mjs");

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wknowledge-backup-cli-"));
  roots.push(root);
  const backupId = "backup-test-001";
  const directory = path.join(root, backupId);
  const entries = [
    ["database.dump", "database-snapshot"],
    ["data/spaces/space-1/wiki/index.md", "# Wiki"],
    ["data/spaces/space-1/mappings/source-map.jsonl", '{"id":"source-1"}\n'],
    ["data/spaces/space-1/raw/version-1.md", "raw source"],
    ["data/spaces/space-1/compiled/version-1/content.md", "compiled source"],
    ["data/blobs/space-1/version-1/source.md", "immutable blob"]
  ] as const;
  await Promise.all(
    entries.map(async ([relative, content]) => {
      const target = path.join(directory, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    })
  );
  const files = entries.map(([relative, content]) => ({
    path: relative,
    byteSize: Buffer.byteLength(content),
    sha256: digest(content)
  }));
  await writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        backupId,
        createdAt: "2026-08-14T00:00:00.000Z",
        applicationVersion: "test",
        files,
        totalBytes: files.reduce((sum, file) => sum + file.byteSize, 0)
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return { root, backupId, directory };
}

async function verify(root: string, backupId: string) {
  return execFileAsync(process.execPath, [backupCli, "verify", "--backup-id", backupId], {
    env: { ...process.env, WKNOWLEDGE_BACKUP_ROOT: root }
  });
}

describe("backup CLI verification", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("accepts an intact database, spaces and immutable blob snapshot", async () => {
    const value = await fixture();
    const result = await verify(value.root, value.backupId);

    expect(JSON.parse(result.stdout)).toEqual({
      backupId: value.backupId,
      fileCount: 6,
      totalBytes: 80
    });
    expect(result.stderr).toBe("");
  });

  it("rejects changed and untracked backup content without exposing its path", async () => {
    const value = await fixture();
    await writeFile(
      path.join(value.directory, "data", "spaces", "space-1", "wiki", "index.md"),
      "changed"
    );

    await expect(verify(value.root, value.backupId)).rejects.toMatchObject({
      stderr: "BACKUP_CONTENT_INTEGRITY_FAILED\n"
    });

    await writeFile(
      path.join(value.directory, "data", "spaces", "space-1", "wiki", "extra.md"),
      "extra"
    );
    await expect(verify(value.root, value.backupId)).rejects.toMatchObject({
      stderr: "BACKUP_CONTENT_UNTRACKED\n"
    });
  });

  it("rejects symbolic links in the snapshot before following their targets", async () => {
    const value = await fixture();
    const target = path.join(value.directory, "data", "blobs", "space-1", "version-1", "source.md");
    const link = path.join(value.directory, "data", "blobs", "space-1", "version-1", "linked.md");
    await symlink(target, link);

    await expect(verify(value.root, value.backupId)).rejects.toMatchObject({
      stderr: "BACKUP_SYMLINK_UNSUPPORTED\n"
    });
  });

  it("refuses a restore without all explicit destructive-action safeguards", async () => {
    const value = await fixture();
    const result = await execFileAsync(
      process.execPath,
      [backupCli, "restore", "--backup-id", value.backupId, "--confirm", value.backupId],
      { env: { ...process.env, WKNOWLEDGE_BACKUP_ROOT: value.root } }
    ).catch((error) => error);

    expect(result.stderr).toBe("BACKUP_RESTORE_QUIESCE_REQUIRED\n");
  });
});
