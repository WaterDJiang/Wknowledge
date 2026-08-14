"use client";

import { useEffect, useState } from "react";
import type { ApiError, DeadLetterQueueHealth } from "@wknowledge/contracts";
import { useWorkspace } from "./workspace-shell";

const BATCH_SIZES = [1, 25, 50, 100] as const;

function formatTime(value: string | null) {
  if (!value) return "无";
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

export function QueueHealth() {
  const { setNotice } = useWorkspace();
  const [health, setHealth] = useState<DeadLetterQueueHealth | null>(null);
  const [limit, setLimit] = useState<(typeof BATCH_SIZES)[number]>(25);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const response = await fetch("/api/settings/queue-health");
    if (!response.ok) throw new Error(await readError(response, "队列状态读取失败"));
    const data = (await response.json()) as { health: DeadLetterQueueHealth };
    setHealth(data.health);
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/queue-health", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readError(response, "队列状态读取失败"));
        return response.json() as Promise<{ health: DeadLetterQueueHealth }>;
      })
      .then((data) => setHealth(data.health))
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "队列状态读取失败");
      });
    return () => controller.abort();
  }, []);

  async function retryFailed() {
    setBusy(true);
    setError("");
    const response = await fetch("/api/settings/queue-health/redrive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit })
    });
    if (!response.ok) {
      setError(await readError(response, "失败任务重新处理失败"));
      setBusy(false);
      return;
    }
    const data = (await response.json()) as { moved: number; skipped: number };
    setNotice(
      data.moved
        ? `已创建 ${data.moved} 个新的处理任务${data.skipped ? `，跳过 ${data.skipped} 个` : ""}`
        : "没有可重新处理的失败任务"
    );
    try {
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "队列状态刷新失败");
    }
    setBusy(false);
  }

  return (
    <section className="panel settings-panel" aria-labelledby="queue-heading">
      <div className="panel-head settings-panel-head">
        <div>
          <span>04</span>
          <h2 id="queue-heading">任务队列</h2>
        </div>
        <small>当前组织 · 状态汇总</small>
      </div>
      <div className="settings-intro">
        <p>
          仅显示当前组织资料版本的最新处理状态。重新处理会创建新的可追溯任务，不会修改原始资料或历史处理记录。
        </p>
        <b>{health?.deadLetter.queuedCount ?? 0} 个可重新处理的失败任务</b>
      </div>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {health ? (
        <div className="settings-grid queue-health-grid">
          <article className="settings-card">
            <h3>资源处理</h3>
            <dl className="settings-facts">
              <div>
                <dt>排队</dt>
                <dd>{health.processing.queuedCount}</dd>
              </div>
              <div>
                <dt>执行中</dt>
                <dd>{health.processing.activeCount}</dd>
              </div>
              <div>
                <dt>失败记录</dt>
                <dd>{health.processing.failedCount}</dd>
              </div>
              <div>
                <dt>总计</dt>
                <dd>{health.processing.totalCount}</dd>
              </div>
            </dl>
          </article>
          <article className="settings-card queue-redrive-card">
            <h3>失败任务</h3>
            <dl className="settings-facts">
              <div>
                <dt>待重新处理</dt>
                <dd>{health.deadLetter.queuedCount}</dd>
              </div>
              <div>
                <dt>最早进入</dt>
                <dd>{formatTime(health.oldestDeadLetterAt)}</dd>
              </div>
            </dl>
            <div className="queue-redrive-actions">
              <label>
                批次
                <select
                  value={limit}
                  onChange={(event) => setLimit(Number(event.target.value) as typeof limit)}
                >
                  {BATCH_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size} 条
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button-secondary"
                disabled={busy || health.jobs.length === 0}
                onClick={() => void retryFailed()}
              >
                {busy ? "重新处理中…" : "重新处理失败任务"}
              </button>
            </div>
          </article>
        </div>
      ) : (
        <p className="settings-empty">正在读取任务队列状态…</p>
      )}
    </section>
  );
}
