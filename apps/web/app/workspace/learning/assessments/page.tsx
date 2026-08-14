"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  assessmentAttemptSchema,
  assessmentSchema,
  type Assessment,
  type AssessmentQuestion
} from "@wknowledge/contracts";
import { useWorkspace } from "../../workspace-shell";

function statusLabel(status: Assessment["status"]) {
  if (status === "draft") return "待开始";
  if (status === "active") return "作答中";
  return "已提交";
}

export default function AssessmentsPage() {
  const { setNotice } = useWorkspace();
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = useMemo(
    () => assessments.find(({ id }) => id === selectedId) ?? assessments[0] ?? null,
    [assessments, selectedId]
  );

  function replaceAssessment(next: Assessment) {
    setAssessments((current) => current.map((value) => (value.id === next.id ? next : value)));
    setSelectedId(next.id);
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/learning/assessments", { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as {
          assessments?: unknown;
          message?: string;
        } | null;
        if (!response.ok) throw new Error(data?.message ?? "正式测评暂时无法读取");
        const next = assessmentSchema.array().parse(data?.assessments);
        setAssessments(next);
        setSelectedId(next[0]?.id ?? "");
      })
      .catch((value: unknown) => {
        if (value instanceof DOMException && value.name === "AbortError") return;
        setError(value instanceof Error ? value.message : "正式测评读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function start() {
    if (!selected) return;
    setActing(true);
    setError(null);
    try {
      const response = await fetch(`/api/learning/assessments/${selected.id}/start`, {
        method: "POST"
      });
      const data = (await response.json().catch(() => null)) as {
        assessment?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "正式测评无法开始");
      replaceAssessment(assessmentSchema.parse(data?.assessment));
      setNotice("正式测评已开始；每道题只能提交一次");
    } catch (value) {
      setError(value instanceof Error ? value.message : "正式测评无法开始");
    } finally {
      setActing(false);
    }
  }

  async function submitAttempt(question: AssessmentQuestion, response: string) {
    if (!selected) return;
    const result = await fetch(`/api/learning/assessments/${selected.id}/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assessmentQuestionId: question.id, response })
    });
    const data = (await result.json().catch(() => null)) as {
      attempt?: unknown;
      message?: string;
    } | null;
    if (!result.ok) throw new Error(data?.message ?? "测评答案保存失败");
    const attempt = assessmentAttemptSchema.parse(data?.attempt);
    replaceAssessment({
      ...selected,
      questions: selected.questions.map((value) =>
        value.id === question.id ? { ...value, attempts: [attempt] } : value
      )
    });
    setNotice(
      attempt.grade
        ? `本题已判定：${attempt.grade.correct ? "回答正确" : "建议回看原文依据"}`
        : "本题已保存，等待人工复核"
    );
  }

  async function submit() {
    if (!selected) return;
    setActing(true);
    setError(null);
    try {
      const response = await fetch(`/api/learning/assessments/${selected.id}/submit`, {
        method: "POST"
      });
      const data = (await response.json().catch(() => null)) as {
        assessment?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "正式测评无法提交");
      replaceAssessment(assessmentSchema.parse(data?.assessment));
      setNotice("正式测评已提交；题卷、作答和原文依据已固定保存");
    } catch (value) {
      setError(value instanceof Error ? value.message : "正式测评无法提交");
    } finally {
      setActing(false);
    }
  }

  if (loading) return <p className="empty">正在读取正式测评…</p>;
  if (error && !selected) return <p className="form-error">{error}</p>;
  if (!selected)
    return (
      <section className="assessment-empty">
        <p>FORMAL ASSESSMENT</p>
        <h2>还没有正式测评</h2>
        <span>请先在学习计划中完成原文学习，生成候选练习后确认一套正式测评。</span>
        <Link href="/workspace/learning/practice">返回练习与测评 →</Link>
      </section>
    );

  const answered = selected.questions.filter(({ attempts }) => attempts.length).length;
  return (
    <section className="assessment-workspace">
      <header className="assessment-head">
        <div>
          <p className="eyebrow">FORMAL ASSESSMENT / M6-07</p>
          <h2>{selected.title}</h2>
          <span>
            {selected.questions.length} 题 · 已作答 {answered} 题 · 题卷与原文版本已冻结
          </span>
        </div>
        <span className={`assessment-status ${selected.status}`}>
          {statusLabel(selected.status)}
        </span>
      </header>
      {error ? <p className="form-error">{error}</p> : null}
      <div className="assessment-layout">
        <aside className="assessment-list" aria-label="正式测评列表">
          <p>已确认题卷</p>
          {assessments.map((assessment) => (
            <button
              key={assessment.id}
              className={assessment.id === selected.id ? "active" : ""}
              onClick={() => setSelectedId(assessment.id)}
            >
              <b>{assessment.title}</b>
              <small>
                {statusLabel(assessment.status)} · {assessment.questions.length} 题
              </small>
            </button>
          ))}
          <Link href="/workspace/learning/practice">← 返回练习与测评</Link>
        </aside>
        <main className="assessment-paper">
          {selected.status === "draft" ? (
            <section className="assessment-intro">
              <h3>开始前确认</h3>
              <p>开始后每道题只能提交一次。请先打开原文依据确认学习范围，再开始本次测评。</p>
              <button onClick={() => void start()} disabled={acting}>
                {acting ? "正在开始…" : "开始正式测评"}
              </button>
            </section>
          ) : null}
          {selected.questions.map((question) => (
            <AssessmentQuestionCard
              key={question.id}
              question={question}
              disabled={selected.status !== "active"}
              onSubmit={submitAttempt}
            />
          ))}
          {selected.status === "active" ? (
            <footer className="assessment-submit">
              <span>
                {answered === selected.questions.length
                  ? "已完成全部作答，可以提交题卷。"
                  : "完成所有题目后才能提交题卷。"}
              </span>
              <button
                disabled={acting || answered !== selected.questions.length}
                onClick={() => void submit()}
              >
                {acting ? "正在提交…" : "提交正式测评"}
              </button>
            </footer>
          ) : null}
        </main>
      </div>
    </section>
  );
}

function AssessmentQuestionCard({
  question,
  disabled,
  onSubmit
}: {
  question: AssessmentQuestion;
  disabled: boolean;
  onSubmit: (question: AssessmentQuestion, response: string) => Promise<void>;
}) {
  const attempt = question.attempts[0] ?? null;
  const [response, setResponse] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!response.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(question, response);
      setResponse("");
    } catch (value) {
      setError(value instanceof Error ? value.message : "测评答案保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <article className="assessment-question">
      <header>
        <span>第 {String(question.ordinal).padStart(2, "0")} 题</span>
        <Link
          href={`/workspace/source?ref=${encodeURIComponent(question.sourceRef)}`}
          target="_blank"
        >
          查看原文依据 ↗
        </Link>
      </header>
      <h3>{question.prompt}</h3>
      <small>{question.rubric.note}</small>
      {attempt ? (
        <section className="assessment-answer">
          <p>{attempt.response}</p>
          <small>
            {attempt.grade
              ? `${attempt.grade.correct ? "回答正确" : "需要回顾"} · ${attempt.grade.score}/${attempt.grade.maximumScore}`
              : "已提交，等待人工复核"}
          </small>
          {attempt.grade?.rationale ? <small>评分依据：{attempt.grade.rationale}</small> : null}
        </section>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <label>
            你的作答
            <textarea
              value={response}
              onChange={(event) => setResponse(event.target.value)}
              disabled={disabled || submitting}
              maxLength={4000}
              required
              placeholder={disabled ? "请先开始正式测评" : "根据原文依据作答"}
            />
          </label>
          <button disabled={disabled || submitting || !response.trim()}>
            {submitting ? "正在保存…" : "提交本题"}
          </button>
          {error ? <small className="form-error">{error}</small> : null}
        </form>
      )}
    </article>
  );
}
