"use client";

import { useEffect, useState } from "react";
import type { ApiError } from "@wknowledge/contracts";

type AuditExportStatus = { retentionDays: number | null };

export function AuditExport() {
  const [status, setStatus] = useState<AuditExportStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/audit-export/status", { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json()) as AuditExportStatus | ApiError;
        if (!response.ok) throw new Error((data as ApiError).message ?? "审计保留状态读取失败");
        return data as AuditExportStatus;
      })
      .then(setStatus)
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "审计保留状态读取失败");
      });
    return () => controller.abort();
  }, []);

  async function download() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/settings/audit-export");
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as ApiError | null;
        throw new Error(data?.message ?? "审计导出失败");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "wknowledge-audit.json";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "审计导出失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel settings-panel" aria-labelledby="audit-export-heading">
      <div className="panel-head settings-panel-head">
        <div>
          <span>07</span>
          <h2 id="audit-export-heading">审计导出与保留</h2>
        </div>
        <small>metadata only · JSON</small>
      </div>
      <div className="settings-intro">
        <p>下载本组织最近 24 小时的审计事件元数据；不包含资料、问题、回答、来源、密钥或路径。</p>
        <b>
          {status
            ? status.retentionDays
              ? `计划保留 ${status.retentionDays} 天`
              : "当前不自动清理"
            : "正在读取保留状态"}
        </b>
      </div>
      <button className="button-secondary" disabled={busy} onClick={() => void download()}>
        {busy ? "正在准备导出…" : "下载审计 JSON"}
      </button>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
