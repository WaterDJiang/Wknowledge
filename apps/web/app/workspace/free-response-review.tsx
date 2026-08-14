"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import type { ManualFreeResponseReviewItem } from "@wknowledge/contracts";

export function FreeResponseReviewQueue({
  items,
  busy,
  onReview
}: {
  items: ManualFreeResponseReviewItem[];
  busy: boolean;
  onReview: (item: ManualFreeResponseReviewItem, score: number, rationale: string) => Promise<void>;
}) {
  return (
    <section className="panel settings-panel" aria-labelledby="free-response-review-heading">
      <div className="panel-head settings-panel-head">
        <div>
          <span>03</span>
          <h2 id="free-response-review-heading">人工复核</h2>
        </div>
        <small>frozen Attempt · rubric · source evidence</small>
      </div>
      <div className="settings-intro">
        <p>仅显示本组织待复核的自由作答。评分依据是冻结题面与量表，不调用模型或 Skill。</p>
        <b>{items.length} 项待办</b>
      </div>
      {items.length ? (
        <div className="free-response-review-list">
          {items.map((item) => (
            <FreeResponseReviewCard
              key={`${item.attemptType}:${item.attemptId}`}
              item={item}
              busy={busy}
              onReview={onReview}
            />
          ))}
        </div>
      ) : (
        <p className="settings-empty">当前没有待人工复核的自由作答。</p>
      )}
    </section>
  );
}

function FreeResponseReviewCard({
  item,
  busy,
  onReview
}: {
  item: ManualFreeResponseReviewItem;
  busy: boolean;
  onReview: (item: ManualFreeResponseReviewItem, score: number, rationale: string) => Promise<void>;
}) {
  const [score, setScore] = useState(0);
  const [rationale, setRationale] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onReview(item, score, rationale.trim());
      setRationale("");
    } catch (value) {
      setError(value instanceof Error ? value.message : "人工评分保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <article className="free-response-review-card">
      <header>
        <div>
          <span>{item.attemptType === "assessment" ? "正式测评" : "日常练习"}</span>
          <small>{new Date(item.submittedAt).toLocaleString("zh-CN")}</small>
        </div>
        <Link href={`/workspace/source?ref=${encodeURIComponent(item.sourceRef)}`} target="_blank">
          查看原文依据 ↗
        </Link>
      </header>
      <h3>{item.prompt}</h3>
      <dl>
        <div>
          <dt>评分量表</dt>
          <dd>{item.rubric.criteria.join(" · ")}</dd>
        </div>
        <div>
          <dt>评分提示</dt>
          <dd>{item.rubric.note}</dd>
        </div>
      </dl>
      <section className="free-response-answer">
        <p>学习者作答</p>
        <blockquote>{item.response}</blockquote>
      </section>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          分数（满分 {item.rubric.maximumScore}）
          <input
            type="number"
            min={0}
            max={item.rubric.maximumScore}
            value={score}
            onChange={(event) => setScore(Number(event.target.value))}
            disabled={busy || submitting}
            required
          />
        </label>
        <label>
          评分依据
          <textarea
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            minLength={1}
            maxLength={1000}
            placeholder="根据冻结量表说明评分依据"
            disabled={busy || submitting}
            required
          />
        </label>
        <button disabled={busy || submitting || !rationale.trim()}>
          {submitting ? "正在保存…" : "确认人工评分"}
        </button>
        {error ? <small className="form-error">{error}</small> : null}
      </form>
    </article>
  );
}
