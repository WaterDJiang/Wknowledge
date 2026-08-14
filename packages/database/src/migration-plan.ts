import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

const MIGRATION_TAG_PATTERN = /^\d{4}_[a-z0-9_]+$/;

export type ExpectedMigration = {
  tag: string;
  folderMillis: number;
  hash: string;
};

export type AppliedMigration = {
  hash: string;
  folderMillis: number;
};

export type DatabaseUpgradePlan = {
  status: "initial" | "pending" | "current";
  appliedCount: number;
  pendingTags: string[];
  lastAppliedTag: string | null;
};

type Journal = {
  entries: Array<{ tag: string; when: number }>;
};

function invalidMigrationSource(): never {
  throw new Error("UPGRADE_MIGRATION_SOURCE_INVALID");
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function readExpectedMigrations(migrationsRoot: string): Promise<ExpectedMigration[]> {
  let journal: Journal;
  try {
    journal = JSON.parse(
      await readFile(path.join(migrationsRoot, "meta", "_journal.json"), "utf8")
    ) as Journal;
  } catch {
    return invalidMigrationSource();
  }
  if (!Array.isArray(journal.entries)) return invalidMigrationSource();
  const migrations = await Promise.all(
    journal.entries.map(async (entry) => {
      if (!MIGRATION_TAG_PATTERN.test(entry.tag) || !validTimestamp(entry.when))
        return invalidMigrationSource();
      let contents: string;
      try {
        contents = await readFile(path.join(migrationsRoot, `${entry.tag}.sql`), "utf8");
      } catch {
        return invalidMigrationSource();
      }
      return {
        tag: entry.tag,
        folderMillis: entry.when,
        hash: createHash("sha256").update(contents).digest("hex")
      };
    })
  );
  const tags = new Set(migrations.map(({ tag }) => tag));
  const timestamps = new Set(migrations.map(({ folderMillis }) => folderMillis));
  if (tags.size !== migrations.length || timestamps.size !== migrations.length)
    return invalidMigrationSource();
  if (
    migrations.some(
      (migration, index) =>
        index > 0 && migration.folderMillis <= migrations[index - 1]!.folderMillis
    )
  )
    return invalidMigrationSource();
  return migrations;
}

export function planDatabaseUpgrade(
  expected: readonly ExpectedMigration[],
  applied: readonly AppliedMigration[]
): DatabaseUpgradePlan {
  if (applied.length > expected.length) throw new Error("UPGRADE_DATABASE_MIGRATION_DIVERGED");
  for (const [index, record] of applied.entries()) {
    const migration = expected[index];
    if (
      !migration ||
      !validTimestamp(record.folderMillis) ||
      !/^[a-f0-9]{64}$/.test(record.hash) ||
      record.folderMillis !== migration.folderMillis ||
      record.hash !== migration.hash
    )
      throw new Error("UPGRADE_DATABASE_MIGRATION_DIVERGED");
  }
  const pending = expected.slice(applied.length);
  return {
    status: applied.length === 0 ? "initial" : pending.length > 0 ? "pending" : "current",
    appliedCount: applied.length,
    pendingTags: pending.map(({ tag }) => tag),
    lastAppliedTag: applied.length > 0 ? expected[applied.length - 1]!.tag : null
  };
}

export async function readAppliedMigrations(databaseUrl: string): Promise<AppliedMigration[]> {
  if (!databaseUrl) throw new Error("UPGRADE_DATABASE_URL_REQUIRED");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const table = await pool.query<{ migrationTable: string | null }>(
      "select to_regclass('drizzle.__drizzle_migrations') as \"migrationTable\""
    );
    if (!table.rows[0]?.migrationTable) return [];
    const result = await pool.query<{ hash: string; folderMillis: string }>(
      'select hash, created_at::text as "folderMillis" from "drizzle"."__drizzle_migrations" order by created_at asc, id asc'
    );
    return result.rows.map(({ hash, folderMillis }) => ({
      hash,
      folderMillis: Number(folderMillis)
    }));
  } catch (error) {
    if (error instanceof Error && error.message === "UPGRADE_DATABASE_URL_REQUIRED") throw error;
    throw new Error("UPGRADE_DATABASE_UNAVAILABLE");
  } finally {
    await pool.end().catch(() => undefined);
  }
}
