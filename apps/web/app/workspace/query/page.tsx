"use client";

import { useState, type FormEvent } from "react";
import {
  groundedQueryResultSchema,
  type ApiError,
  type EvidenceItem,
  type GroundedQueryResult
} from "@wknowledge/contracts";
import { useWorkspace } from "../workspace-shell";
import { partitionEvidence } from "./evidence";

const VISIBLE_SOURCE_COUNT = 3;
const TYPE_LABELS: Record<EvidenceItem["pageType"], string> = {
  concept: "概念",
  topic: "主题",
  case: "案例",
  course: "课程",
  material: "资料"
};

function sourceHref(ref: string): string {
  return `/workspace/source?ref=${encodeURIComponent(ref)}`;
}

function SourceLink({
  locatorRef,
  index,
  title
}: {
  locatorRef: string;
  index: number;
  title: string;
}) {
  const number = String(index + 1).padStart(2, "0");
  return (
    <a
      aria-label={`打开《${title}》的来源定位 ${number}`}
      href={sourceHref(locatorRef)}
      target="_blank"
      rel="noreferrer"
    >
      原资料 {number} ↗
    </a>
  );
}

function EvidenceCard({ item }: { item: EvidenceItem }) {
  const visible = item.sourceRefs.slice(0, VISIBLE_SOURCE_COUNT);
  const remaining = item.sourceRefs.slice(VISIBLE_SOURCE_COUNT);
  return (
    <article className="evidence-card">
      <header>
        <div>
          <span>{item.id.replace("evidence-", "证据 ")}</span>
          <b>{item.pageTitle}</b>
        </div>
        <small>
          {TYPE_LABELS[item.pageType]} · {item.sourceRefs.length} 个定位
        </small>
      </header>
      <blockquote>{item.text}</blockquote>
      <div className="evidence-source-links">
        {visible.map((ref, index) => (
          <SourceLink key={ref} locatorRef={ref} index={index} title={item.pageTitle} />
        ))}
      </div>
      {remaining.length > 0 ? (
        <details>
          <summary>查看其余 {remaining.length} 个原资料定位</summary>
          <div className="evidence-source-links evidence-source-links-more">
            {remaining.map((ref, index) => (
              <SourceLink
                key={ref}
                locatorRef={ref}
                index={index + VISIBLE_SOURCE_COUNT}
                title={item.pageTitle}
              />
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

function AnswerResult({ result }: { result: GroundedQueryResult }) {
  const citedIds = new Set(result.answer.evidenceIds);
  const { cited: citedEvidence, related: relatedEvidence } = partitionEvidence(
    result.evidence.items,
    citedIds
  );
  const fallback = result.answer.mode === "extractive_fallback";
  return (
    <>
      <div className={`answer-mode ${fallback ? "fallback" : "generated"}`}>
        <span>{fallback ? "检索摘要模式" : "模型生成"}</span>
        <p>
          {fallback
            ? "当前未配置可用的对话模型。以下内容直接整理自知识库证据，没有使用模型常识补全。"
            : "回答由对话模型基于下方证据生成，并通过引用校验。"}
        </p>
      </div>
      <section className="answer-section" aria-labelledby="answer-heading">
        <p className="answer-kicker">回答</p>
        <h3 id="answer-heading">
          {result.answer.insufficientEvidence ? "现有知识不足以回答" : "基于当前知识库"}
        </h3>
        <p className="answer-copy">{result.answer.answer}</p>
      </section>
      {citedEvidence.length > 0 ? (
        <section className="evidence-section" aria-labelledby="evidence-heading">
          <header>
            <div>
              <p className="answer-kicker">依据与原资料</p>
              <h3 id="evidence-heading">{citedEvidence.length} 条证据支持这个回答</h3>
            </div>
            <small>Embedding 调用 {result.evidence.embeddingCalls}</small>
          </header>
          <div className="evidence-list">
            {citedEvidence.map((item) => (
              <EvidenceCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      ) : null}
      {relatedEvidence.length > 0 ? (
        <section
          className="evidence-section related-evidence-section"
          aria-labelledby="related-heading"
        >
          <details>
            <summary id="related-heading">另外检索到 {relatedEvidence.length} 条相关候选</summary>
            <p>这些页面参与了本轮检索，但未被当前回答直接引用。展开后可查看摘要与原资料定位。</p>
            <div className="evidence-list">
              {relatedEvidence.map((item) => (
                <EvidenceCard key={item.id} item={item} />
              ))}
            </div>
          </details>
        </section>
      ) : null}
    </>
  );
}

export default function QueryPage() {
  const { activeId, setNotice } = useWorkspace();
  const [answer, setAnswer] = useState<GroundedQueryResult | null>(null);
  const [error, setError] = useState<Pick<ApiError, "message" | "suggestion"> | null>(null);
  const [busy, setBusy] = useState(false);

  async function query(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeId) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    setNotice("正在检索证据并生成回答…");
    try {
      const response = await fetch(`/api/spaces/${activeId}/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: form.get("question") })
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as ApiError | null;
        setAnswer(null);
        setError({
          message: result?.message ?? "知识检索暂时不可用",
          suggestion: result?.suggestion
        });
        setNotice(result?.code === "WIKI_NOT_READY" ? "知识库仍在处理中" : "查询失败");
        return;
      }
      const raw = (await response.json()) as { result?: unknown };
      const parsed = groundedQueryResultSchema.safeParse(raw.result);
      if (!parsed.success) throw new Error("QUERY_RESPONSE_INVALID");
      setAnswer(parsed.data);
      setNotice(
        parsed.data.answer.insufficientEvidence
          ? "知识库依据不足"
          : parsed.data.answer.mode === "generated"
            ? "已生成有据回答"
            : "已完成检索摘要"
      );
    } catch {
      setAnswer(null);
      setError({ message: "无法读取有据回答", suggestion: "检查服务状态后重试" });
      setNotice("查询失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel query-panel">
      <div className="panel-head">
        <div>
          <span>03</span>
          <h2>有据问答</h2>
        </div>
        <small>index → evidence → answer</small>
      </div>
      <form className="query-box" onSubmit={query}>
        <textarea
          name="question"
          placeholder="基于这个空间里的资料提问…"
          minLength={2}
          required
          disabled={!activeId}
        />
        <button disabled={!activeId || busy}>{busy ? "检索并生成…" : "提问 ↗"}</button>
      </form>
      <div className="answer-paper">
        {error ? (
          <div className="query-error" role="alert">
            <b>{error.message}</b>
            {error.suggestion ? <p>{error.suggestion}</p> : null}
          </div>
        ) : !answer ? (
          <p className="empty">回答、知识证据和原资料定位会分别显示在这里。</p>
        ) : (
          <AnswerResult result={answer} />
        )}
      </div>
    </section>
  );
}
