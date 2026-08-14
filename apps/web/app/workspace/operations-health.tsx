"use client";

import { useEffect, useState } from "react";
import type { ApiError } from "@wknowledge/contracts";
import type {
  OrganizationOperationsAlertCode,
  OrganizationOperationsSnapshot
} from "@wknowledge/core";

const ALERT_LABELS: Record<OrganizationOperationsAlertCode, string> = {
  PROCESSING_STALE: "存在超时处理任务",
  WORKER_UNAVAILABLE: "后台 Worker 未报告健康心跳",
  PROVIDERS_UNAVAILABLE: "已启用模型均不可用",
  MODEL_FAILURE_RATE_HIGH: "模型调用失败率超过 20%",
  STORAGE_UTILIZATION_HIGH: "存储占用超过 85%"
};

function errorMessage(error: ApiError | null) {
  return error?.message ?? "系统运行状态读取失败";
}

export function OperationsHealth() {
  const [snapshot, setSnapshot] = useState<OrganizationOperationsSnapshot | null>(null);
  const [alerts, setAlerts] = useState<OrganizationOperationsAlertCode[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/operations-health", { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json()) as
          | { snapshot: OrganizationOperationsSnapshot; alerts: OrganizationOperationsAlertCode[] }
          | ApiError;
        if (!response.ok) throw new Error(errorMessage(data as ApiError));
        return data as {
          snapshot: OrganizationOperationsSnapshot;
          alerts: OrganizationOperationsAlertCode[];
        };
      })
      .then((data) => {
        setSnapshot(data.snapshot);
        setAlerts(data.alerts);
      })
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "系统运行状态读取失败");
      });
    return () => controller.abort();
  }, []);

  return (
    <section className="panel settings-panel" aria-labelledby="operations-health-heading">
      <div className="panel-head settings-panel-head">
        <div>
          <span>05</span>
          <h2 id="operations-health-heading">系统运行状态</h2>
        </div>
        <small>24h aggregates · metadata only</small>
      </div>
      <div className="settings-intro">
        <p>只汇总任务、模型与容量指标；不读取资料正文、问题、回答、来源或密钥。</p>
        <b>{alerts.length ? `${alerts.length} 项需处理` : "运行指标正常"}</b>
      </div>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {alerts.length ? (
        <ul className="settings-alert-list">
          {alerts.map((alert) => (
            <li key={alert}>{ALERT_LABELS[alert]}</li>
          ))}
        </ul>
      ) : null}
      {snapshot ? (
        <div className="settings-grid storage-usage-grid">
          <article className="settings-card">
            <h3>资料处理</h3>
            <dl className="settings-facts">
              <div>
                <dt>排队 / 执行</dt>
                <dd>
                  {snapshot.processing.queuedCount} / {snapshot.processing.activeCount}
                </dd>
              </div>
              <div>
                <dt>超时任务</dt>
                <dd>{snapshot.processing.staleCount}</dd>
              </div>
              <div>
                <dt>Worker</dt>
                <dd>{snapshot.worker.status === "healthy" ? "正常" : "不可用"}</dd>
              </div>
            </dl>
          </article>
          <article className="settings-card">
            <h3>模型服务</h3>
            <dl className="settings-facts">
              <div>
                <dt>健康 / 已启用</dt>
                <dd>
                  {snapshot.providers.healthyCount} / {snapshot.providers.enabledCount}
                </dd>
              </div>
              <div>
                <dt>24h 失败率</dt>
                <dd>{Math.round(snapshot.modelCalls.failureRate * 100)}%</dd>
              </div>
            </dl>
          </article>
        </div>
      ) : (
        <p className="settings-empty">正在读取系统运行状态…</p>
      )}
    </section>
  );
}
