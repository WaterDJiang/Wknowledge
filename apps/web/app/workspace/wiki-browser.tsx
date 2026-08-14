"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import type { ApiError, WikiPageDetail, WikiPageSummary } from "@wknowledge/contracts";
import { WikiChangeProposalReview } from "./wiki-change-proposal-review";
import { WikiConflictReview } from "./wiki-conflict-review";

const STATUS_LABELS: Record<WikiPageSummary["status"], string> = {
  draft: "草稿",
  reviewed: "已审核",
  conflicted: "有冲突",
  deprecated: "已停用"
};

const TYPE_LABELS: Record<WikiPageSummary["type"], string> = {
  concept: "概念",
  topic: "主题",
  case: "案例",
  course: "课程",
  material: "资料"
};

const KNOWLEDGE_TYPES = ["topic", "concept", "case", "course"] as const;
type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

interface MarkdownLine {
  code: boolean;
  line: string;
}

function markdownLines(content: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let code = false;
  for (const line of content.split("\n")) {
    if (line.startsWith("```")) {
      code = !code;
      continue;
    }
    lines.push({ code, line });
  }
  return lines;
}

function MarkdownBody({ content }: { content: string }) {
  return (
    <div className="wiki-markdown">
      {markdownLines(content).map(({ code, line }, index) => {
        const key = `${index}-${line.slice(0, 20)}`;
        if (code) return <code key={key}>{line || " "}</code>;
        if (!line.trim()) return <span className="wiki-spacer" key={key} />;
        const heading = /^(#{1,4})\s+(.+)$/.exec(line);
        if (heading) {
          const level = heading[1]?.length ?? 2;
          const text = heading[2] ?? "";
          if (level === 1) return <h2 key={key}>{text}</h2>;
          if (level === 2) return <h3 key={key}>{text}</h3>;
          return <h4 key={key}>{text}</h4>;
        }
        if (/^>\s*来源：wk:\/\//.test(line))
          return (
            <p className="source-inline" key={key}>
              来源定位已连接到右侧来源面板
            </p>
          );
        if (line.startsWith(">")) return <blockquote key={key}>{line.slice(1).trim()}</blockquote>;
        if (/^[-*]\s+/.test(line))
          return (
            <p className="wiki-list-item" key={key}>
              {line.replace(/^[-*]\s+/, "")}
            </p>
          );
        return <p key={key}>{line}</p>;
      })}
    </div>
  );
}

const REVIEW_ROLES = new Set(["owner", "admin", "editor"]);

export function WikiBrowser({ spaceId, activeRole }: { spaceId: string; activeRole: string }) {
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [activePageId, setActivePageId] = useState("");
  const [page, setPage] = useState<WikiPageDetail | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [filters, setFilters] = useState({ search: "", status: "" });
  const [scope, setScope] = useState<"knowledge" | "materials">("knowledge");
  const [selectedTypes, setSelectedTypes] = useState<KnowledgeType[]>([...KNOWLEDGE_TYPES]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [detailState, setDetailState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [reviewState, setReviewState] = useState<"idle" | "saving">("idle");
  const [reviewError, setReviewError] = useState("");

  useEffect(() => {
    if (!spaceId) return;
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (filters.search) params.set("search", filters.search);
    if (filters.status) params.set("status", filters.status);
    const types = scope === "materials" ? ["material"] : selectedTypes;
    types.forEach((type) => params.append("type", type));
    void fetch(`/api/spaces/${spaceId}/wiki/pages?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("WIKI_LIST_FAILED");
        return (await response.json()) as { pages: WikiPageSummary[] };
      })
      .then((result) => {
        setPages(result.pages);
        setPage(null);
        setDetailState(result.pages.length ? "loading" : "idle");
        setActivePageId((current) =>
          result.pages.some(({ id }) => id === current) ? current : (result.pages[0]?.id ?? "")
        );
        setListState("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setListState("error");
      });
    return () => controller.abort();
  }, [filters, refreshToken, scope, selectedTypes, spaceId]);

  useEffect(() => {
    if (!spaceId || !activePageId) return;
    const controller = new AbortController();
    void fetch(`/api/spaces/${spaceId}/wiki/pages/${encodeURIComponent(activePageId)}`, {
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("WIKI_PAGE_READ_FAILED");
        return (await response.json()) as { page: WikiPageDetail };
      })
      .then((result) => {
        setPage(result.page);
        setDetailState("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setDetailState("error");
      });
    return () => controller.abort();
  }, [activePageId, filters, refreshToken, spaceId]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setListState("loading");
    setDetailState("loading");
    setPage(null);
    setFilters({ search: search.trim(), status });
  }

  function refreshWiki() {
    setListState("loading");
    setDetailState("loading");
    setPage(null);
    setRefreshToken((value) => value + 1);
  }

  function selectPage(pageId: string) {
    if (pageId === activePageId) return;
    setPage(null);
    setDetailState("loading");
    setActivePageId(pageId);
  }

  async function updateReview(action: "approve" | "reopen") {
    if (!page || reviewState === "saving") return;
    setReviewState("saving");
    setReviewError("");
    const response = await fetch(
      `/api/spaces/${spaceId}/wiki/pages/${encodeURIComponent(page.id)}/review`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action })
      }
    );
    const result = (await response.json().catch(() => null)) as
      { page: WikiPageDetail } | ApiError | null;
    if (!response.ok || !result || !("page" in result)) {
      setReviewError(
        result && "message" in result ? result.message : "审核操作失败，请刷新后重试。"
      );
      setReviewState("idle");
      return;
    }
    applyUpdatedPage(result.page);
    setReviewState("idle");
  }

  function applyUpdatedPage(updatedPage: WikiPageDetail) {
    setPage(updatedPage);
    setPages((current) =>
      current.map((item) => {
        if (item.id !== updatedPage.id) return item;
        const updated: WikiPageSummary = {
          ...item,
          status: updatedPage.status,
          humanVerified: updatedPage.humanVerified
        };
        delete updated.reviewedAt;
        delete updated.reviewedBy;
        if (updatedPage.reviewedAt) updated.reviewedAt = updatedPage.reviewedAt;
        if (updatedPage.reviewedBy) updated.reviewedBy = updatedPage.reviewedBy;
        return updated;
      })
    );
  }

  function toggleKnowledgeType(type: KnowledgeType) {
    setSelectedTypes((current) => {
      if (current.includes(type))
        return current.length === 1 ? current : current.filter((value) => value !== type);
      return KNOWLEDGE_TYPES.filter((value) => [...current, type].includes(value));
    });
  }

  return (
    <section className="panel wiki-panel" id="wiki">
      <div className="panel-head">
        <div>
          <span>02</span>
          <h2>知识库</h2>
        </div>
        <small>
          {listState === "loading"
            ? "读取索引…"
            : `${pages.length} 个${scope === "knowledge" ? "知识页面" : "资料索引"}`}
        </small>
      </div>

      <div className="wiki-domain-bar">
        <div className="wiki-scope-switch" aria-label="知识库内容域">
          <button
            className={scope === "knowledge" ? "active" : ""}
            type="button"
            onClick={() => setScope("knowledge")}
          >
            知识内容
            <small>主题、概念、案例与课程</small>
          </button>
          <button
            className={scope === "materials" ? "active" : ""}
            type="button"
            onClick={() => setScope("materials")}
          >
            资料索引
            <small>原资料在 Wiki 中的总览</small>
          </button>
        </div>
        <Link href="/workspace/resources">管理原始资料 ↗</Link>
      </div>

      {scope === "knowledge" ? (
        <div className="wiki-type-filter" aria-label="选择知识内容类型">
          <span>管理类型</span>
          {KNOWLEDGE_TYPES.map((type) => (
            <button
              className={selectedTypes.includes(type) ? "active" : ""}
              key={type}
              type="button"
              aria-pressed={selectedTypes.includes(type)}
              onClick={() => toggleKnowledgeType(type)}
            >
              {TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      ) : (
        <p className="wiki-material-note">
          这里显示已发布的材料总览；上传、版本、状态和重试仍在资料库管理。
        </p>
      )}

      <form className="wiki-toolbar" onSubmit={applyFilters}>
        <input
          aria-label="搜索知识页面"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索标题、标签或正文"
          disabled={!spaceId}
        />
        <select
          aria-label="筛选页面状态"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          disabled={!spaceId}
        >
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="reviewed">已审核</option>
          <option value="conflicted">有冲突</option>
          <option value="deprecated">已停用</option>
        </select>
        <button type="submit" disabled={!spaceId}>
          筛选
        </button>
        <button className="wiki-refresh" type="button" onClick={refreshWiki} disabled={!spaceId}>
          刷新
        </button>
      </form>

      {!spaceId ? (
        <p className="empty wiki-empty">请先创建或选择一个知识空间。</p>
      ) : listState === "error" ? (
        <div className="wiki-feedback" role="alert">
          <b>知识索引读取失败</b>
          <button onClick={refreshWiki}>重试</button>
        </div>
      ) : pages.length === 0 && listState === "ready" ? (
        <p className="empty wiki-empty">
          {scope === "knowledge"
            ? "没有符合条件的知识内容。上传资料时选择“知识提炼”或“案例整理”。"
            : "还没有资料索引。已上传的原文件仍可在资料库管理。"}
        </p>
      ) : (
        <div className="wiki-browser">
          <nav className="wiki-page-list" aria-label="知识页面">
            {pages.map((item) => (
              <button
                className={item.id === activePageId ? "active" : ""}
                key={item.id}
                onClick={() => selectPage(item.id)}
                type="button"
              >
                <span>
                  {TYPE_LABELS[item.type]} · {STATUS_LABELS[item.status]}
                </span>
                <b>{item.title}</b>
                <p>{item.excerpt || "该页面暂无摘要"}</p>
                <small>
                  {item.tags.slice(0, 3).join(" · ") || "未标记"} / {item.sourceCount} 个来源
                </small>
              </button>
            ))}
          </nav>

          <article className="wiki-reader" aria-live="polite">
            {detailState === "loading" ? <p className="empty">正在读取知识正文…</p> : null}
            {detailState === "error" ? (
              <div className="wiki-feedback" role="alert">
                <b>知识正文读取失败</b>
                <button onClick={() => setActivePageId("")}>关闭</button>
              </div>
            ) : null}
            {page ? (
              <>
                <header>
                  <div className="wiki-reader-heading">
                    <div>
                      <span className={`wiki-status ${page.status}`}>
                        {STATUS_LABELS[page.status]}
                      </span>
                      <span className="wiki-marking">{page.sourceMarking}</span>
                    </div>
                    {REVIEW_ROLES.has(activeRole) && ["draft", "reviewed"].includes(page.status) ? (
                      <button
                        className="wiki-review-button"
                        type="button"
                        disabled={reviewState === "saving"}
                        onClick={() =>
                          void updateReview(page.status === "reviewed" ? "reopen" : "approve")
                        }
                      >
                        {reviewState === "saving"
                          ? "正在保存…"
                          : page.status === "reviewed"
                            ? "重新打开为草稿"
                            : "批准此页面"}
                      </button>
                    ) : null}
                  </div>
                  <h3>{page.title}</h3>
                  <p>
                    {TYPE_LABELS[page.type]} · 更新于{" "}
                    {new Date(page.lastCompiled).toLocaleString("zh-CN")}
                  </p>
                  {page.reviewedAt ? (
                    <p className="wiki-review-meta">
                      人工审核于 {new Date(page.reviewedAt).toLocaleString("zh-CN")} ·
                      审核记录已锁定
                    </p>
                  ) : null}
                  {reviewError ? (
                    <p className="wiki-review-error" role="alert">
                      {reviewError}
                    </p>
                  ) : null}
                </header>
                <div className="wiki-reader-grid">
                  <MarkdownBody content={page.content} />
                  <aside className="wiki-sources">
                    <p>来源依据</p>
                    <b>{page.sourceRefs.length} 个可解析定位</b>
                    {page.sourceRefs.map((ref, index) => (
                      <a
                        key={ref}
                        href={`/workspace/source?ref=${encodeURIComponent(ref)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        来源 {String(index + 1).padStart(2, "0")} ↗
                      </a>
                    ))}
                  </aside>
                </div>
                {REVIEW_ROLES.has(activeRole) ? (
                  <WikiChangeProposalReview
                    key={`${page.id}-${page.lastCompiled}`}
                    spaceId={spaceId}
                    pageId={page.id}
                    onPageUpdated={applyUpdatedPage}
                  />
                ) : null}
                <WikiConflictReview
                  key={`${page.id}-${page.conflictIds.join("-")}`}
                  spaceId={spaceId}
                  page={page}
                  pages={pages}
                  activeRole={activeRole}
                  onChanged={refreshWiki}
                />
              </>
            ) : null}
          </article>
        </div>
      )}
    </section>
  );
}
