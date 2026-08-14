import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BACKUP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MANIFEST_FILE = "manifest.json";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function safeRelative(value) {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  )
    fail("BACKUP_MANIFEST_PATH_INVALID");
  return normalized;
}

function backupId(value) {
  if (!value || !BACKUP_ID_PATTERN.test(value)) fail("BACKUP_ID_INVALID");
  return value;
}

function argument(name) {
  const positions = process.argv.reduce(
    (all, value, index) => (value === name ? [...all, index] : all),
    []
  );
  if (positions.length !== 1) fail("BACKUP_ARGUMENT_INVALID");
  const value = process.argv[positions[0] + 1];
  if (!value || value.startsWith("--")) fail("BACKUP_ARGUMENT_INVALID");
  return value;
}

async function exists(target) {
  return lstat(target).then(
    () => true,
    (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  );
}

async function realDirectory(target, code) {
  const metadata = await lstat(target).catch(() => fail(code));
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail(code);
  return path.resolve(target);
}

async function hashFile(target) {
  const bytes = await readFile(target);
  return createHash("sha256").update(bytes).digest("hex");
}

async function listRegularFiles(root, relative = "") {
  const directory = relative ? path.join(root, relative) : root;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() =>
    fail("BACKUP_SOURCE_UNREADABLE")
  );
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isSymbolicLink()) fail("BACKUP_SYMLINK_UNSUPPORTED");
    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(root, child)));
      continue;
    }
    if (!entry.isFile()) fail("BACKUP_SOURCE_ENTRY_UNSUPPORTED");
    files.push(safeRelative(child));
  }
  return files;
}

async function copyTree(sourceRoot, destinationRoot, prefix) {
  const files = await listRegularFiles(sourceRoot);
  await mkdir(destinationRoot, { recursive: true });
  return Promise.all(
    files.map(async (relative) => {
      const source = path.join(sourceRoot, relative);
      const target = path.join(destinationRoot, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      const metadata = await stat(target);
      if (!metadata.isFile()) fail("BACKUP_COPY_FAILED");
      return {
        path: safeRelative(path.posix.join(prefix, relative)),
        byteSize: metadata.size,
        sha256: await hashFile(target)
      };
    })
  );
}

async function descriptor(target, relative) {
  const metadata = await stat(target).catch(() => fail("BACKUP_DATABASE_DUMP_FAILED"));
  if (!metadata.isFile()) fail("BACKUP_DATABASE_DUMP_FAILED");
  return { path: safeRelative(relative), byteSize: metadata.size, sha256: await hashFile(target) };
}

function manifestShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("BACKUP_MANIFEST_INVALID");
  if (value.schemaVersion !== 1 || typeof value.backupId !== "string")
    fail("BACKUP_MANIFEST_INVALID");
  backupId(value.backupId);
  if (typeof value.createdAt !== "string" || typeof value.applicationVersion !== "string")
    fail("BACKUP_MANIFEST_INVALID");
  if (
    !Array.isArray(value.files) ||
    !Number.isSafeInteger(value.totalBytes) ||
    value.totalBytes < 0
  )
    fail("BACKUP_MANIFEST_INVALID");
  const files = value.files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) fail("BACKUP_MANIFEST_INVALID");
    if (
      typeof file.path !== "string" ||
      !Number.isSafeInteger(file.byteSize) ||
      file.byteSize < 0 ||
      typeof file.sha256 !== "string" ||
      !SHA256_PATTERN.test(file.sha256)
    )
      fail("BACKUP_MANIFEST_INVALID");
    const relative = safeRelative(file.path);
    if (
      relative !== "database.dump" &&
      !relative.startsWith("data/spaces/") &&
      !relative.startsWith("data/blobs/")
    )
      fail("BACKUP_MANIFEST_INVALID");
    return { path: relative, byteSize: file.byteSize, sha256: file.sha256 };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length)
    fail("BACKUP_MANIFEST_INVALID");
  if (!files.some((file) => file.path === "database.dump")) fail("BACKUP_MANIFEST_INVALID");
  if (files.reduce((sum, file) => sum + file.byteSize, 0) !== value.totalBytes)
    fail("BACKUP_MANIFEST_INVALID");
  return { ...value, files };
}

async function run(command, argumentsList) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, { stdio: "ignore", env: process.env });
    child.once("error", () => reject(new Error("BACKUP_DATABASE_TOOL_UNAVAILABLE")));
    child.once("exit", (code) =>
      code === 0 ? resolve(undefined) : reject(new Error("BACKUP_DATABASE_COMMAND_FAILED"))
    );
  });
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function verifyDirectory(directory, expectedId) {
  const root = await realDirectory(directory, "BACKUP_NOT_FOUND");
  const raw = await readFile(path.join(root, MANIFEST_FILE), "utf8").catch(() =>
    fail("BACKUP_MANIFEST_INVALID")
  );
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("BACKUP_MANIFEST_INVALID");
  }
  const manifest = manifestShape(parsed);
  if (manifest.backupId !== expectedId) fail("BACKUP_MANIFEST_ID_MISMATCH");

  const recorded = new Map(manifest.files.map((file) => [file.path, file]));
  const actual = ["database.dump"];
  for (const rootName of ["data/spaces", "data/blobs"]) {
    const treeRoot = path.join(root, rootName);
    await realDirectory(treeRoot, "BACKUP_CONTENT_MISSING");
    actual.push(
      ...(await listRegularFiles(treeRoot)).map((relative) => path.posix.join(rootName, relative))
    );
  }
  if (actual.length !== recorded.size || actual.some((relative) => !recorded.has(relative)))
    fail("BACKUP_CONTENT_UNTRACKED");

  for (const relative of actual) {
    const file = recorded.get(relative);
    if (!file) fail("BACKUP_CONTENT_UNTRACKED");
    const target = path.join(root, relative);
    const metadata = await lstat(target).catch(() => fail("BACKUP_CONTENT_MISSING"));
    if (metadata.isSymbolicLink() || !metadata.isFile()) fail("BACKUP_CONTENT_INVALID");
    if (metadata.size !== file.byteSize || (await hashFile(target)) !== file.sha256)
      fail("BACKUP_CONTENT_INTEGRITY_FAILED");
  }
  return manifest;
}

async function createBackup() {
  if (process.env.WKNOWLEDGE_BACKUP_QUIESCED !== "true") fail("BACKUP_QUIESCE_REQUIRED");
  if (!process.env.DATABASE_URL) fail("BACKUP_DATABASE_URL_REQUIRED");

  const id = backupId(
    process.env.WKNOWLEDGE_BACKUP_ID ??
      `backup-${new Date()
        .toISOString()
        .replaceAll(/[-:.TZ]/g, "")
        .toLowerCase()}`
  );
  const dataRoot = await realDirectory(
    process.env.WKNOWLEDGE_DATA_ROOT ?? path.join(process.cwd(), "data", "spaces"),
    "BACKUP_DATA_ROOT_INVALID"
  );
  const blobRoot = await realDirectory(
    process.env.WKNOWLEDGE_BLOB_ROOT ?? path.join(process.cwd(), "data", "blobs"),
    "BACKUP_BLOB_ROOT_INVALID"
  );
  const backupRoot = path.resolve(
    process.env.WKNOWLEDGE_BACKUP_ROOT ?? path.join(process.cwd(), "backups")
  );
  await mkdir(backupRoot, { recursive: true });
  const realBackupRoot = await realDirectory(backupRoot, "BACKUP_ROOT_INVALID");
  if (isInside(dataRoot, realBackupRoot) || isInside(blobRoot, realBackupRoot))
    fail("BACKUP_ROOT_OVERLAPS_SOURCE");

  const finalDirectory = path.join(realBackupRoot, id);
  const stagingDirectory = path.join(realBackupRoot, `.${id}.staging`);
  if ((await exists(finalDirectory)) || (await exists(stagingDirectory))) fail("BACKUP_ID_EXISTS");
  await mkdir(stagingDirectory, { recursive: false });
  try {
    const dump = path.join(stagingDirectory, "database.dump");
    await run("pg_dump", [
      "--format=custom",
      "--no-owner",
      "--file",
      dump,
      "--dbname",
      process.env.DATABASE_URL
    ]);
    const files = [
      await descriptor(dump, "database.dump"),
      ...(await copyTree(dataRoot, path.join(stagingDirectory, "data", "spaces"), "data/spaces")),
      ...(await copyTree(blobRoot, path.join(stagingDirectory, "data", "blobs"), "data/blobs"))
    ];
    const manifest = {
      schemaVersion: 1,
      backupId: id,
      createdAt: new Date().toISOString(),
      applicationVersion: process.env.WKNOWLEDGE_RELEASE_VERSION ?? "unknown",
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
      totalBytes: files.reduce((sum, file) => sum + file.byteSize, 0)
    };
    await writeFile(
      path.join(stagingDirectory, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    await rename(stagingDirectory, finalDirectory);
    output({
      backupId: manifest.backupId,
      fileCount: manifest.files.length,
      totalBytes: manifest.totalBytes
    });
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function verifyBackup() {
  const id = backupId(argument("--backup-id"));
  const root = path.resolve(
    process.env.WKNOWLEDGE_BACKUP_ROOT ?? path.join(process.cwd(), "backups")
  );
  const manifest = await verifyDirectory(path.join(root, id), id);
  output({
    backupId: manifest.backupId,
    fileCount: manifest.files.length,
    totalBytes: manifest.totalBytes
  });
}

async function restoreBackup() {
  const id = backupId(argument("--backup-id"));
  if (argument("--confirm") !== id) fail("BACKUP_RESTORE_CONFIRMATION_REQUIRED");
  if (process.env.WKNOWLEDGE_RESTORE_QUIESCED !== "true") fail("BACKUP_RESTORE_QUIESCE_REQUIRED");
  if (process.env.WKNOWLEDGE_RESTORE_DATABASE !== "true") fail("BACKUP_RESTORE_DATABASE_REQUIRED");
  if (!process.env.DATABASE_URL) fail("BACKUP_DATABASE_URL_REQUIRED");
  if (!process.env.WKNOWLEDGE_RESTORE_DATA_ROOT || !process.env.WKNOWLEDGE_RESTORE_BLOB_ROOT)
    fail("BACKUP_RESTORE_TARGET_REQUIRED");

  const backupRoot = path.resolve(
    process.env.WKNOWLEDGE_BACKUP_ROOT ?? path.join(process.cwd(), "backups")
  );
  const sourceDirectory = path.join(backupRoot, id);
  const manifest = await verifyDirectory(sourceDirectory, id);
  const dataTarget = path.resolve(process.env.WKNOWLEDGE_RESTORE_DATA_ROOT);
  const blobTarget = path.resolve(process.env.WKNOWLEDGE_RESTORE_BLOB_ROOT);
  if (isInside(dataTarget, blobTarget) || isInside(blobTarget, dataTarget))
    fail("BACKUP_RESTORE_TARGET_INVALID");
  if ((await exists(dataTarget)) || (await exists(blobTarget)))
    fail("BACKUP_RESTORE_TARGET_EXISTS");

  const dataStage = `${dataTarget}.wknowledge-${id}.staging`;
  const blobStage = `${blobTarget}.wknowledge-${id}.staging`;
  if ((await exists(dataStage)) || (await exists(blobStage))) fail("BACKUP_RESTORE_STAGING_EXISTS");
  let dataPublished = false;
  let blobPublished = false;
  try {
    await copyTree(path.join(sourceDirectory, "data", "spaces"), dataStage, "data/spaces");
    await copyTree(path.join(sourceDirectory, "data", "blobs"), blobStage, "data/blobs");
    await run("pg_restore", [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--dbname",
      process.env.DATABASE_URL,
      path.join(sourceDirectory, "database.dump")
    ]);
    await rename(dataStage, dataTarget);
    dataPublished = true;
    await rename(blobStage, blobTarget);
    blobPublished = true;
    output({
      backupId: manifest.backupId,
      fileCount: manifest.files.length,
      totalBytes: manifest.totalBytes
    });
  } catch (error) {
    await rm(dataStage, { recursive: true, force: true });
    await rm(blobStage, { recursive: true, force: true });
    if (dataPublished) await rm(dataTarget, { recursive: true, force: true });
    if (blobPublished) await rm(blobTarget, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const operation = process.argv[2];
  if (operation === "create") return createBackup();
  if (operation === "verify") return verifyBackup();
  if (operation === "restore") return restoreBackup();
  fail("BACKUP_OPERATION_INVALID");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? error?.message ?? "BACKUP_UNEXPECTED_FAILURE"}\n`);
    process.exitCode = 1;
  });
}
