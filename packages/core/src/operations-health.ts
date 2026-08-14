import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDatabase, readLatestWorkerHeartbeat, schema } from "@wknowledge/database";

const MODEL_WINDOW_MS = 24 * 60 * 60 * 1_000;
const PROCESSING_STALE_MS = 15 * 60 * 1_000;
const WORKER_STALE_MS = 120 * 1_000;

export interface OrganizationOperationsSnapshot {
  observedAt: string;
  processing: {
    queuedCount: number;
    activeCount: number;
    failedCount: number;
    staleCount: number;
  };
  worker: {
    status: "healthy" | "stale" | "unavailable";
    heartbeatAt: string | null;
  };
  providers: {
    enabledCount: number;
    healthyCount: number;
    unhealthyCount: number;
    unknownCount: number;
  };
  modelCalls: {
    windowHours: 24;
    totalCount: number;
    failedCount: number;
    failureRate: number;
  };
  storage: {
    usedBytes: number;
    reservedBytes: number;
    quotaBytes: number;
    utilization: number;
  };
}

export type OrganizationOperationsAlertCode =
  | "PROCESSING_STALE"
  | "WORKER_UNAVAILABLE"
  | "PROVIDERS_UNAVAILABLE"
  | "MODEL_FAILURE_RATE_HIGH"
  | "STORAGE_UTILIZATION_HIGH";

export function assessOrganizationOperationsAlerts(
  snapshot: OrganizationOperationsSnapshot
): OrganizationOperationsAlertCode[] {
  const alerts: OrganizationOperationsAlertCode[] = [];
  if (snapshot.processing.staleCount > 0) alerts.push("PROCESSING_STALE");
  if (snapshot.worker.status !== "healthy") alerts.push("WORKER_UNAVAILABLE");
  if (snapshot.providers.enabledCount > 0 && snapshot.providers.healthyCount === 0)
    alerts.push("PROVIDERS_UNAVAILABLE");
  if (snapshot.modelCalls.totalCount > 0 && snapshot.modelCalls.failureRate > 0.2)
    alerts.push("MODEL_FAILURE_RATE_HIGH");
  if (snapshot.storage.utilization >= 0.85) alerts.push("STORAGE_UTILIZATION_HIGH");
  return alerts;
}

export async function readOrganizationOperationsSnapshot(
  organizationId: string,
  now = new Date()
): Promise<OrganizationOperationsSnapshot> {
  const db = getDatabase();
  const [processing, providers, modelCalls, storageModule, workerHeartbeat] = await Promise.all([
    db
      .select({
        status: schema.processingJobs.status,
        count: sql<number>`count(*)::int`
      })
      .from(schema.processingJobs)
      .innerJoin(
        schema.knowledgeSpaces,
        eq(schema.processingJobs.spaceId, schema.knowledgeSpaces.id)
      )
      .where(eq(schema.knowledgeSpaces.organizationId, organizationId))
      .groupBy(schema.processingJobs.status),
    db
      .select({ enabled: schema.modelProviders.enabled, health: schema.modelProviders.health })
      .from(schema.modelProviders)
      .where(eq(schema.modelProviders.organizationId, organizationId)),
    db
      .select({ status: schema.modelCalls.status, count: sql<number>`count(*)::int` })
      .from(schema.modelCalls)
      .innerJoin(schema.queryRuns, eq(schema.modelCalls.queryRunId, schema.queryRuns.id))
      .where(
        and(
          eq(schema.queryRuns.organizationId, organizationId),
          gte(schema.modelCalls.createdAt, new Date(now.getTime() - MODEL_WINDOW_MS))
        )
      )
      .groupBy(schema.modelCalls.status),
    import("./index"),
    readLatestWorkerHeartbeat().catch(() => null)
  ]);
  const storage = await storageModule.readOrganizationStorageUsage(organizationId);
  const processingCounts = new Map(processing.map((row) => [row.status, Number(row.count)]));
  const stale = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.processingJobs)
    .innerJoin(schema.knowledgeSpaces, eq(schema.processingJobs.spaceId, schema.knowledgeSpaces.id))
    .where(
      and(
        eq(schema.knowledgeSpaces.organizationId, organizationId),
        eq(schema.processingJobs.status, "processing"),
        lt(schema.processingJobs.startedAt, new Date(now.getTime() - PROCESSING_STALE_MS))
      )
    );
  const enabled = providers.filter((provider) => provider.enabled);
  const modelCounts = new Map(modelCalls.map((row) => [row.status, Number(row.count)]));
  const totalModelCalls = [...modelCounts.values()].reduce((total, count) => total + count, 0);
  const failedModelCalls = modelCounts.get("failed") ?? 0;
  const workerStatus =
    workerHeartbeat && now.getTime() - workerHeartbeat.heartbeatAt.getTime() <= WORKER_STALE_MS
      ? "healthy"
      : workerHeartbeat
        ? "stale"
        : "unavailable";
  return {
    observedAt: now.toISOString(),
    processing: {
      queuedCount: processingCounts.get("queued") ?? 0,
      activeCount: processingCounts.get("processing") ?? 0,
      failedCount: processingCounts.get("failed") ?? 0,
      staleCount: Number(stale[0]?.count ?? 0)
    },
    worker: {
      status: workerStatus,
      heartbeatAt: workerHeartbeat?.heartbeatAt.toISOString() ?? null
    },
    providers: {
      enabledCount: enabled.length,
      healthyCount: enabled.filter((provider) => provider.health === "healthy").length,
      unhealthyCount: enabled.filter((provider) => provider.health === "unhealthy").length,
      unknownCount: enabled.filter((provider) => provider.health === "unknown").length
    },
    modelCalls: {
      windowHours: 24,
      totalCount: totalModelCalls,
      failedCount: failedModelCalls,
      failureRate: totalModelCalls === 0 ? 0 : failedModelCalls / totalModelCalls
    },
    storage: {
      usedBytes: storage.usedBytes,
      reservedBytes: storage.reservedBytes,
      quotaBytes: storage.quotaBytes,
      utilization:
        storage.quotaBytes === 0
          ? 0
          : (storage.usedBytes + storage.reservedBytes) / storage.quotaBytes
    }
  };
}
