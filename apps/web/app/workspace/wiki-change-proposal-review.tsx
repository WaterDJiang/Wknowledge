"use client";

import { useEffect, useState } from "react";
import type {
  ApiError,
  WikiPageChangeProposalDetail,
  WikiPageChangeProposalSummary,
  WikiPageDetail,
  WikiPageRevisionSummary
} from "@wknowledge/contracts";

const PROPOSAL_STATUS_LABELS: Record<WikiPageChangeProposalSummary["status"], string> = {
  pending: "待审核",
  accepted: "已接受",
  rejected: "已拒绝",
  stale: "已过期"
};

export function WikiChangeProposalReview({
  spaceId,
  pageId,
  onPageUpdated
}: {
  spaceId: string;
  pageId: string;
  onPageUpdated: (page: WikiPageDetail) => void;
}) {
  const [proposals, setProposals] = useState<WikiPageChangeProposalSummary[]>([]);
  const [revisions, setRevisions] = useState<WikiPageRevisionSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<WikiPageChangeProposalDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [decisionState, setDecisionState] = useState<"idle" | "saving">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/spaces/${spaceId}/wiki/pages/${encodeURIComponent(pageId)}/proposals`, {
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("WIKI_PROPOSAL_LIST_FAILED");
        return (await response.json()) as {
          proposals: WikiPageChangeProposalSummary[];
          revisions: WikiPageRevisionSummary[];
        };
      })
      .then((result) => {
        setProposals(result.proposals);
        setRevisions(result.revisions);
        setSelectedId((current) => {
          if (result.proposals.some((proposal) => proposal.id === current)) return current;
          return result.proposals.find((proposal) => proposal.status === "pending")?.id ?? "";
        });
        setState("ready");
      })
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setState("error");
        setError("待审核变更读取失败，请刷新后重试。");
      });
    return () => controller.abort();
  }, [pageId, spaceId]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    void fetch(
      `/api/spaces/${spaceId}/wiki/pages/${encodeURIComponent(pageId)}/proposals/${encodeURIComponent(selectedId)}`,
      { signal: controller.signal }
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("WIKI_PROPOSAL_READ_FAILED");
        return (await response.json()) as { proposal: WikiPageChangeProposalDetail };
      })
      .then((result) => setDetail(result.proposal))
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setError("变更对比读取失败，请重新选择该提案。");
      });
    return () => controller.abort();
  }, [pageId, selectedId, spaceId]);

  async function decide(action: "accept" | "reject") {
    if (!detail || detail.status !== "pending" || decisionState === "saving") return;
    setDecisionState("saving");
    setError("");
    const response = await fetch(
      `/api/spaces/${spaceId}/wiki/pages/${encodeURIComponent(pageId)}/proposals/${encodeURIComponent(detail.id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action })
      }
    );
    const result = (await response.json().catch(() => null)) as
      { page: WikiPageDetail; proposal: WikiPageChangeProposalSummary } | ApiError | null;
    if (!response.ok || !result || !("page" in result)) {
      setError(result && "message" in result ? result.message : "审核决定保存失败，请刷新后重试。");
      setDecisionState("idle");
      return;
    }
    setProposals((current) =>
      current.map((proposal) => (proposal.id === result.proposal.id ? result.proposal : proposal))
    );
    setDetail((current) => (current ? { ...current, ...result.proposal } : current));
    onPageUpdated(result.page);
    setDecisionState("idle");
  }

  return (
    <section className="wiki-proposal-panel" aria-label="知识页面变更审核">
      <div className="wiki-proposal-head">
        <div>
          <b>页面变更审核</b>
          <small>{state === "loading" ? "读取记录…" : `${revisions.length} 个版本快照`}</small>
        </div>
        {proposals.length > 0 ? (
          <select
            aria-label="选择待审核变更"
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {proposals.map((proposal) => (
              <option key={proposal.id} value={proposal.id}>
                {PROPOSAL_STATUS_LABELS[proposal.status]} ·{" "}
                {new Date(proposal.createdAt).toLocaleString("zh-CN")}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {state === "ready" && proposals.length === 0 ? (
        <p className="wiki-proposal-empty">
          当前没有待发布变更。已审核版本的后续编译会先在这里等待确认。
        </p>
      ) : null}
      {detail && detail.id === selectedId ? (
        <div className="wiki-diff-wrap">
          <p className="wiki-proposal-summary">
            {detail.changedLineCount} 行变更 · {detail.sourceCount} 个候选来源
          </p>
          <div className="wiki-diff" aria-label="逐行变更对比">
            {detail.diff.map((line, index) => (
              <div
                className={`wiki-diff-line ${line.type}`}
                key={`${line.type}-${index}-${line.text}`}
              >
                <span aria-hidden="true">
                  {line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}
                </span>
                <code>{line.text || " "}</code>
              </div>
            ))}
          </div>
          {detail.status === "pending" ? (
            <div className="wiki-proposal-actions">
              <button
                type="button"
                disabled={decisionState === "saving"}
                onClick={() => void decide("reject")}
              >
                拒绝变更
              </button>
              <button
                className="wiki-proposal-accept"
                type="button"
                disabled={decisionState === "saving"}
                onClick={() => void decide("accept")}
              >
                {decisionState === "saving" ? "正在发布…" : "接受并发布"}
              </button>
            </div>
          ) : null}
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
