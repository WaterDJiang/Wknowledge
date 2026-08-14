import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

let pool: Pool | undefined;

export function getDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL."
    );
  }
  pool ??= new Pool({ connectionString, max: 10 });
  return drizzle(pool, { schema });
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export { schema };
export {
  readLatestWorkerHeartbeat,
  recordWorkerHeartbeat,
  removeWorkerHeartbeat,
  type WorkerHeartbeat
} from "./worker-heartbeat";
export {
  acquireWikiPublicationLease,
  heartbeatWikiPublicationLease,
  releaseWikiPublicationLease,
  withWikiPublicationLease,
  type WikiPublicationLease
} from "./wiki-publication-lock";
export type { WikiPublicationLeaseOptions } from "./wiki-publication-lock";
export {
  consumeRequestRateLimit,
  consumeRequestRateLimits,
  type RequestRateLimitBatchResult,
  type RequestRateLimitInput
} from "./request-rate-limit";
export {
  claimExpiredProcessingForRecovery,
  claimProcessingExecution,
  clearCancelledExpiredExecution,
  DEFAULT_PROCESSING_LEASE_MS,
  listExpiredProcessingExecutions,
  refreshProcessingExecution,
  releaseRecoveredProcessingExecution,
  updateProcessingExecutionStage
} from "./processing-execution-lease";
export {
  planDatabaseUpgrade,
  readAppliedMigrations,
  readExpectedMigrations,
  type AppliedMigration,
  type DatabaseUpgradePlan,
  type ExpectedMigration
} from "./migration-plan";
