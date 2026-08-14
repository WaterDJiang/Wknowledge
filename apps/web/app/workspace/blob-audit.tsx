"use client";

import { useEffect, useState } from "react";
import type { ApiError, BlobAuditSummary } from "@wknowledge/contracts";
import { useWorkspace } from "./workspace-shell";

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

async function readError(response: Response, fallback: string) {
  const data = (await response.json().catch(() => null)) as ApiError | null;
  return data?.message ?? fallback;
}

export function BlobAudit() {
  const { setNotice } = useWorkspace();
  const [audit, setAudit] = useState<BlobAuditSummary | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/settings/blob-audit");
    if (!response.ok) throw new Error(await readError(response, "资料存储巡检失败"));
    const data = (await response.json()) as { audit: BlobAuditSummary };
    setAudit(data.audit);
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/blob-audit", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response, "资料存储巡检失败"));
        return response.json() as Promise<{ audit: BlobAuditSummary }>;
      })
      .then((data) => setAudit(data.audit))
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "资料存储巡检失败");
      });
    return () => controller.abort();
  }, []);

  async function refresh() {
    setBusy(true);
    setError("");
    try {
      await load();
      setNotice("资料存储巡检已刷新");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "资料存储巡检失败");
    }
    setBusy(false);
  }

  const issueCount = (audit?.missingReferenceCount ?? 0) + (audit?.unreferencedBlobCount ?? 0);
  return (
    <section className="panel settings-panel" aria-labelledby="blob-audit-heading">
      <div className="panel-head settings-panel-head">
        <div>
          <span>06</span>
          <h2 id="blob-audit-heading">资料存储巡检</h2>
        </div>
        <small>local BlobStore · read-only</small>
      </div>
      <div className="settings-intro">
        <p>只比对版本记录与本地受管文件，不读取正文，也不会删除、移动或修复任何资料。</p>
        <b>{issueCount} 个待人工核查</b>
      </div>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {audit ? (
        <div className="settings-grid blob-audit-grid">
          <article className="settings-card">
            <h3>引用核对</h3>
            <dl className="settings-facts">
              <div>
                <dt>版本引用</dt>
                <dd>{audit.referencedCount}</dd>
              </div>
              <div>
                <dt>已确认存在</dt>
                <dd>{audit.verifiedReferenceCount}</dd>
              </div>
              <div>
                <dt>缺失引用</dt>
                <dd>{audit.missingReferenceCount}</dd>
              </div>
              <div>
                <dt>未检查 URI</dt>
                <dd>{audit.uncheckedReferenceCount}</dd>
              </div>
            </dl>
          </article>
          <article className="settings-card blob-audit-actions">
            <h3>库存核对</h3>
            <dl className="settings-facts">
              <div>
                <dt>本地不可变文件</dt>
                <dd>{audit.inventoryCount}</dd>
              </div>
              <div>
                <dt>未引用文件</dt>
                <dd>{audit.unreferencedBlobCount}</dd>
              </div>
              <div>
                <dt>巡检时间</dt>
                <dd>{formatTime(audit.checkedAt)}</dd>
              </div>
            </dl>
            <div className="blob-audit-actions-footer">
              <p>未引用文件仅是候选线索，当前版本不会自动清理。</p>
              <button className="button-secondary" disabled={busy} onClick={() => void refresh()}>
                {busy ? "巡检中…" : "重新巡检"}
              </button>
            </div>
          </article>
        </div>
      ) : (
        <p className="settings-empty">正在读取资料存储巡检结果…</p>
      )}
    </section>
  );
}
