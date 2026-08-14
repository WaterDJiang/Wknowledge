import { fileURLToPath } from "node:url";
import {
  readAppliedMigrations,
  readExpectedMigrations,
  planDatabaseUpgrade
} from "./migration-plan";

try {
  const expected = await readExpectedMigrations(
    fileURLToPath(new URL("../migrations", import.meta.url))
  );
  const applied = await readAppliedMigrations(process.env.DATABASE_URL ?? "");
  const plan = planDatabaseUpgrade(expected, applied);
  console.info(JSON.stringify(plan));
} catch (error) {
  const code = error instanceof Error ? error.message : "UPGRADE_CHECK_FAILED";
  console.error(/^[A-Z0-9_]+$/.test(code) ? code : "UPGRADE_CHECK_FAILED");
  process.exitCode = 1;
}
