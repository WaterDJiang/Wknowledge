import { sql } from "drizzle-orm";
import { getDatabase } from "@wknowledge/database";

export interface DatabaseReadiness {
  ready: boolean;
  code?: "DATABASE_UNAVAILABLE";
}

export async function readDatabaseReadiness(
  probe: () => Promise<unknown> = () => getDatabase().execute(sql`SELECT 1`)
): Promise<DatabaseReadiness> {
  try {
    await probe();
    return { ready: true };
  } catch {
    return { ready: false, code: "DATABASE_UNAVAILABLE" };
  }
}
