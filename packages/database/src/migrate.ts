import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { closeDatabase, getDatabase } from "./index";

try {
  await migrate(getDatabase(), {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url))
  });
  console.info("Database migrations completed.");
} finally {
  await closeDatabase();
}
