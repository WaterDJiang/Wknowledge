"use client";

import { useEffect, useState } from "react";
import type { ApiError, StorageUsage } from "@wknowledge/contracts";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

async function readError(response: Response, fallback: string) {
  const data = (await response.json().catch(() => null)) as ApiError | null;
  return data?.message ?? fallback;
}

export function StorageUsagePanel() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/storage-usage", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response, "资料存储用量读取失败"));
        return response.json() as Promise<{ usage: StorageUsage }>;
      })
      .then((data) => setUsage(data.usage))
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "资料存储用量读取失败");
      });
    return () => controller.abort();
  }, []);

  return (
    <section className="panel settings-panel" aria-labelledby="storage-usage-heading">
      <div className="panel-head settings-panel-head">
        <div>
          <span>05</span>
          <h2 id="storage-usage-heading">资料存储额度</h2>
        </div>
        <small>unique Blob bytes · active upload reservations</small>
      </div>
      <div className="settings-intro">
        <p>实际用量按去重后的不可变原件计算；正在上传的分片文件会临时预留额度。</p>
        <b>{usage ? `${formatBytes(usage.availableBytes)} 可用` : "读取中"}</b>
      </div>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : usage ? (
        <div className="settings-grid storage-usage-grid">
          <article className="settings-card">
            <h3>额度概览</h3>
            <dl className="settings-facts">
              <div>
                <dt>组织额度</dt>
                <dd>{formatBytes(usage.quotaBytes)}</dd>
              </div>
              <div>
                <dt>可用</dt>
                <dd>{formatBytes(usage.availableBytes)}</dd>
              </div>
            </dl>
          </article>
          <article className="settings-card">
            <h3>已占用</h3>
            <dl className="settings-facts">
              <div>
                <dt>不可变原件</dt>
                <dd>{formatBytes(usage.usedBytes)}</dd>
              </div>
              <div>
                <dt>上传预留</dt>
                <dd>{formatBytes(usage.reservedBytes)}</dd>
              </div>
            </dl>
          </article>
        </div>
      ) : (
        <p className="settings-empty">正在读取资料存储额度…</p>
      )}
    </section>
  );
}
