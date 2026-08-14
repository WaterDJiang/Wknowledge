import { describe, expect, it } from "vitest";
import { assessOrganizationOperationsAlerts, type OrganizationOperationsSnapshot } from "../src";

const base: OrganizationOperationsSnapshot = {
  observedAt: "2026-08-14T00:00:00.000Z",
  processing: { queuedCount: 0, activeCount: 0, failedCount: 0, staleCount: 0 },
  worker: { status: "healthy", heartbeatAt: "2026-08-14T00:00:00.000Z" },
  providers: { enabledCount: 1, healthyCount: 1, unhealthyCount: 0, unknownCount: 0 },
  modelCalls: { windowHours: 24, totalCount: 10, failedCount: 2, failureRate: 0.2 },
  storage: { usedBytes: 80, reservedBytes: 4, quotaBytes: 100, utilization: 0.84 }
};

describe("organization operations alerts", () => {
  it("does not alert at the exact normal thresholds", () => {
    expect(assessOrganizationOperationsAlerts(base)).toEqual([]);
  });

  it("returns stable alert codes without operational data", () => {
    const alerts = assessOrganizationOperationsAlerts({
      ...base,
      processing: { ...base.processing, staleCount: 1 },
      worker: { status: "unavailable", heartbeatAt: null },
      providers: { ...base.providers, healthyCount: 0, unhealthyCount: 1 },
      modelCalls: { ...base.modelCalls, failedCount: 3, failureRate: 0.3 },
      storage: { ...base.storage, utilization: 0.85 }
    });
    expect(alerts).toEqual([
      "PROCESSING_STALE",
      "WORKER_UNAVAILABLE",
      "PROVIDERS_UNAVAILABLE",
      "MODEL_FAILURE_RATE_HIGH",
      "STORAGE_UTILIZATION_HIGH"
    ]);
    expect(JSON.stringify(alerts)).not.toContain("password");
  });
});
