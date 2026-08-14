"use client";

import { useEffect, useState } from "react";
import type {
  ApiError,
  WikiConflictDetail,
  WikiPageDetail,
  WikiPageSummary
} from "@wknowledge/contracts";

const EDIT_ROLES = new Set(["owner", "admin", "editor"]);

export function WikiConflictReview({
  spaceId,
  page,
  pages,
  activeRole,
  onChanged
}: {
  spaceId: string;
  page: WikiPageDetail;
  pages: WikiPageSummary[];
  activeRole: string;
  onChanged: () => void;
}) {
  const [selectedPageId, setSelectedPageId] = useState("");
  const [conflict, setConflict] = useState<WikiConflictDetail | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState("");
  const conflictId = page.conflictIds[0];
  const editable = EDIT_ROLES.has(activeRole);
  const alternatives = pages.filter(
    (candidate) => candidate.id !== page.id && candidate.status !== "deprecated"
  );

  useEffect(() => {
    if (!conflictId) return;
    const controller = new AbortController();
    void fetch(`/api/spaces/${spaceId}/wiki/conflicts/${encodeURIComponent(conflictId)}`, {
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("WIKI_CONFLICT_READ_FAILED");
        return (await response.json()) as { conflict: WikiConflictDetail };
      })
      .then((result) => setConflict(result.conflict))
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setError("冲突详情读取失败，请刷新页面后重试。");
      });
    return () => controller.abort();
  }, [conflictId, spaceId]);

  async function declareConflict() {
    if (!selectedPageId || state === "saving") return;
    setState("saving");
    setError("");
    const response = await fetch(`/api/spaces/${spaceId}/wiki/conflicts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leftPageId: page.id, rightPageId: selectedPageId })
    });
    const result = (await response.json().catch(() => null)) as
      { conflict: WikiConflictDetail } | ApiError | null;
    if (!response.ok || !result || !("conflict" in result)) {
      setError(result && "message" in result ? result.message : "冲突声明失败，请刷新后重试。");
      setState("error");
      return;
    }
    setConflict(result.conflict);
    setState("idle");
    onChanged();
  }

  async function decide(action: "select_left" | "select_right" | "keep_parallel") {
    if (!conflictId || state === "saving") return;
    setState("saving");
    setError("");
    const response = await fetch(
      `/api/spaces/${spaceId}/wiki/conflicts/${encodeURIComponent(conflictId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action })
      }
    );
    const result = (await response.json().catch(() => null)) as
      { conflict: WikiConflictDetail } | ApiError | null;
    if (!response.ok || !result || !("conflict" in result)) {
      setError(result && "message" in result ? result.message : "冲突裁决失败，请刷新后重试。");
      setState("error");
      return;
    }
    setConflict(result.conflict);
    setState("idle");
    onChanged();
  }

  if (conflictId) {
    return (
      <section className="wiki-conflict-panel" aria-label="知识冲突">
        <header>
          <div>
            <b>并列结论提示</b>
            <p>这份内容存在已登记的来源冲突，不能作为唯一结论使用。</p>
          </div>
          <small>{conflict?.status === "parallel" ? "保留并列" : "待人工裁决"}</small>
        </header>
        {conflict ? (
          <div className="wiki-conflict-sides">
            <p>
              左侧：{conflict.left.title} · {conflict.left.sourceCount} 个来源
            </p>
            <p>
              右侧：{conflict.right.title} · {conflict.right.sourceCount} 个来源
            </p>
          </div>
        ) : null}
        {editable && conflict && conflict.status !== "resolved" ? (
          <div className="wiki-conflict-actions">
            <button
              type="button"
              disabled={state === "saving"}
              onClick={() => void decide("keep_parallel")}
            >
              保留并列
            </button>
            <button
              type="button"
              disabled={state === "saving"}
              onClick={() => void decide("select_left")}
            >
              采用左侧结论
            </button>
            <button
              type="button"
              disabled={state === "saving"}
              onClick={() => void decide("select_right")}
            >
              采用右侧结论
            </button>
          </div>
        ) : null}
        {error ? (
          <p className="wiki-review-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  if (!editable || alternatives.length === 0) return null;
  return (
    <section className="wiki-conflict-panel wiki-conflict-declare" aria-label="声明知识冲突">
      <b>发现来源结论冲突？</b>
      <p>选择另一份有依据的知识页面，系统会并列保存双方内容，等待人工裁决。</p>
      <div>
        <select
          aria-label="选择冲突页面"
          value={selectedPageId}
          onChange={(event) => setSelectedPageId(event.target.value)}
        >
          <option value="">选择另一份知识页面</option>
          {alternatives.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!selectedPageId || state === "saving"}
          onClick={() => void declareConflict()}
        >
          {state === "saving" ? "正在保存…" : "声明冲突"}
        </button>
      </div>
      {error ? (
        <p className="wiki-review-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
