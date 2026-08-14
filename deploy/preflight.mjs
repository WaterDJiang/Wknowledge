import { lstat, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MIN_FREE_BYTES = 1024n * 1024n * 1024n;
const RELEASE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function databaseUrl(value) {
  if (!value) fail("PREFLIGHT_DATABASE_URL_INVALID");
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
      !parsed.hostname ||
      !parsed.pathname ||
      parsed.pathname === "/"
    )
      fail("PREFLIGHT_DATABASE_URL_INVALID");
  } catch {
    fail("PREFLIGHT_DATABASE_URL_INVALID");
  }
}

function productionPassword(value) {
  if (!value || value === "wknowledge") fail("PREFLIGHT_POSTGRES_PASSWORD_INVALID");
}

function releaseVersion(value) {
  if (!value || value === "unknown" || !RELEASE_VERSION_PATTERN.test(value))
    fail("PREFLIGHT_RELEASE_VERSION_INVALID");
}

function credentialKey(value) {
  if (!value || Buffer.from(value, "base64url").byteLength !== 32)
    fail("PREFLIGHT_CREDENTIAL_KEY_INVALID");
}

function minimumFreeBytes(value) {
  if (value === undefined || value === "") return DEFAULT_MIN_FREE_BYTES;
  if (!/^\d+$/.test(value)) fail("PREFLIGHT_MIN_FREE_BYTES_INVALID");
  const parsed = BigInt(value);
  if (parsed <= 0n) fail("PREFLIGHT_MIN_FREE_BYTES_INVALID");
  return parsed;
}

async function managedDirectory(value, fallback, code) {
  const requested = path.resolve(value ?? fallback);
  const metadata = await lstat(requested).catch(() => fail(code));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(code);
  return realpath(requested).catch(() => fail(code));
}

async function availableBytes(root) {
  const filesystem = await statfs(root, { bigint: true }).catch(() =>
    fail("PREFLIGHT_CAPACITY_UNAVAILABLE")
  );
  return filesystem.bavail * filesystem.bsize;
}

async function preflight() {
  databaseUrl(process.env.DATABASE_URL);
  productionPassword(process.env.POSTGRES_PASSWORD);
  releaseVersion(process.env.WKNOWLEDGE_RELEASE_VERSION);
  credentialKey(process.env.WKNOWLEDGE_CREDENTIAL_KEY);
  const dataRoot = await managedDirectory(
    process.env.WKNOWLEDGE_DATA_ROOT,
    path.join(process.cwd(), "data", "spaces"),
    "PREFLIGHT_DATA_ROOT_INVALID"
  );
  const blobRoot = await managedDirectory(
    process.env.WKNOWLEDGE_BLOB_ROOT,
    path.join(process.cwd(), "data", "blobs"),
    "PREFLIGHT_BLOB_ROOT_INVALID"
  );
  if (isInside(dataRoot, blobRoot) || isInside(blobRoot, dataRoot))
    fail("PREFLIGHT_STORAGE_ROOTS_OVERLAP");
  const minimum = minimumFreeBytes(process.env.WKNOWLEDGE_MIN_FREE_BYTES);
  const available = await Promise.all([availableBytes(dataRoot), availableBytes(blobRoot)]);
  if (available.some((value) => value < minimum)) fail("PREFLIGHT_CAPACITY_INSUFFICIENT");
  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      checks: ["database_url", "release_version", "credential_key", "storage_roots", "capacity"],
      availableBytes: available.map((value) => value.toString())
    })}\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  preflight().catch((error) => {
    process.stderr.write(`${error?.code ?? error?.message ?? "PREFLIGHT_UNEXPECTED_FAILURE"}\n`);
    process.exitCode = 1;
  });
}
