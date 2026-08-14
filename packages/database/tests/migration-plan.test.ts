import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planDatabaseUpgrade, readExpectedMigrations } from "../src/migration-plan";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wknowledge-migration-plan-"));
  roots.push(root);
  await mkdir(path.join(root, "meta"));
  await writeFile(
    path.join(root, "meta", "_journal.json"),
    JSON.stringify({
      entries: [
        { tag: "0000_first_change", when: 100 },
        { tag: "0001_second_change", when: 200 }
      ]
    })
  );
  await writeFile(path.join(root, "0000_first_change.sql"), "create table first_table ();\n");
  await writeFile(path.join(root, "0001_second_change.sql"), "create table second_table ();\n");
  return root;
}

describe("database upgrade plan", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("derives deterministic initial, pending and current states from Drizzle source files", async () => {
    const root = await fixture();
    const expected = await readExpectedMigrations(root);

    expect(planDatabaseUpgrade(expected, [])).toEqual({
      status: "initial",
      appliedCount: 0,
      pendingTags: ["0000_first_change", "0001_second_change"],
      lastAppliedTag: null
    });
    expect(planDatabaseUpgrade(expected, [expected[0]!])).toEqual({
      status: "pending",
      appliedCount: 1,
      pendingTags: ["0001_second_change"],
      lastAppliedTag: "0000_first_change"
    });
    expect(planDatabaseUpgrade(expected, expected)).toEqual({
      status: "current",
      appliedCount: 2,
      pendingTags: [],
      lastAppliedTag: "0001_second_change"
    });
  });

  it("fails closed for altered SQL, migration order or duplicate journal timestamps", async () => {
    const root = await fixture();
    const expected = await readExpectedMigrations(root);
    const changedHash = createHash("sha256").update("changed").digest("hex");

    expect(() => planDatabaseUpgrade(expected, [{ ...expected[0]!, hash: changedHash }])).toThrow(
      "UPGRADE_DATABASE_MIGRATION_DIVERGED"
    );
    expect(() => planDatabaseUpgrade(expected, [expected[1]!])).toThrow(
      "UPGRADE_DATABASE_MIGRATION_DIVERGED"
    );

    await writeFile(
      path.join(root, "meta", "_journal.json"),
      JSON.stringify({
        entries: [
          { tag: "0000_first_change", when: 100 },
          { tag: "0001_second_change", when: 100 }
        ]
      })
    );
    await expect(readExpectedMigrations(root)).rejects.toThrow("UPGRADE_MIGRATION_SOURCE_INVALID");
  });
});
