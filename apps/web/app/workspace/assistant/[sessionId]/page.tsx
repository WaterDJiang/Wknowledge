"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  agentContextBindingSchema,
  agentKnowledgeToolCallSchema,
  agentMessageSchema,
  agentRunSchema,
  agentRunStreamEventSchema,
  agentSessionSummarySchema,
  groundedQueryResultSchema,
  sessionSkillSchema,
  skillApprovalSchema,
  skillRunSchema,
  type AgentContextBinding,
  type AgentContextScope,
  type AgentKnowledgeToolCall,
  type AgentMessage,
  type AgentRun,
  type AgentSessionSummary,
  type EvidenceItem,
  type GroundedQueryResult,
  type SessionSkill,
  type SkillApproval,
  type SkillRun
} from "@wknowledge/contracts";
import {
  assistantStageLabel,
  stageForRequestedTool,
  toolStepsForRun,
  type AssistantToolStage,
  type AssistantToolStep
} from "../../assistant-tool-trace";
import { completedSkillRunSummary, skillRunStatusLabel } from "../../assistant-skill-run-summary";
import { partitionEvidence } from "../../query/evidence";
import { useWorkspace } from "../../workspace-shell";

const TYPE_LABELS: Record<EvidenceItem["pageType"], string> = {
  concept: "概念",
  topic: "主题",
  case: "案例",
  course: "课程",
  material: "资料"
};

interface SessionDetail {
  session: AgentSessionSummary;
  bindings: AgentContextBinding[];
  messages: AgentMessage[];
  runs: AgentRun[];
  toolCalls: AgentKnowledgeToolCall[];
}

interface ActiveTurn {
  runId: string;
  userMessage: AgentMessage | null;
  text: string;
  stage: "starting" | AssistantToolStage;
}

interface SessionSkillState {
  skills: SessionSkill[];
  approvals: SkillApproval[];
}

interface ContextOptions {
  pages: Array<{ id: string; title: string; type: string }>;
  versions: Array<{ id: string; label: string; originalName: string }>;
  courses: Array<{ id: string; label: string }>;
}

function parseSseEvents(value: string): Array<{ type: string; data: string }> {
  return value.split("\n\n").flatMap((block) => {
    const name = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    return name && data ? [{ type: name, data }] : [];
  });
}

function sourceHref(ref: string): string {
  return `/workspace/source?ref=${encodeURIComponent(ref)}`;
}

function skillBindings(
  skill: SessionSkill,
  activeBindings: AgentContextBinding[]
): AgentContextBinding[] {
  if (skill.permissions.resources === "none") return [];
  if (skill.permissions.resources === "space")
    return activeBindings.filter(({ scope }) => scope === "space");
  return activeBindings;
}

function skillInputSummary(skill: SessionSkill, bindingCount: number): string {
  return `允许 ${skill.description} 使用当前 ${bindingCount} 个受管知识范围`;
}

function skillExecutionLabel(skill: SessionSkill): string {
  if (skill.execution === "conversation") return "对话内置";
  if (skill.execution === "worker") return "受管 Worker";
  return "执行器待接入";
}

function sourceLinks(item: EvidenceItem) {
  return (
    <div className="assistant-source-links">
      {item.sourceRefs.slice(0, 3).map((ref, index) => (
        <a key={ref} href={sourceHref(ref)} target="_blank" rel="noreferrer">
          原资料 {String(index + 1).padStart(2, "0")} ↗
        </a>
      ))}
    </div>
  );
}

function TurnSources({ result }: { result: GroundedQueryResult }) {
  const citedIds = new Set(result.answer.evidenceIds);
  const { cited, related } = partitionEvidence(result.evidence.items, citedIds);
  return (
    <details className="assistant-turn-sources">
      <summary>
        本轮来源 · {cited.length} 条直接依据{related.length ? `，${related.length} 条相关候选` : ""}
      </summary>
      <div className="assistant-source-list">
        {cited.map((item) => (
          <article key={item.id}>
            <header>
              <span>{TYPE_LABELS[item.pageType]}</span>
              <b>{item.pageTitle}</b>
            </header>
            <p>{item.text}</p>
            {sourceLinks(item)}
          </article>
        ))}
        {related.length ? (
          <details className="assistant-related-sources">
            <summary>另外检索到 {related.length} 条相关候选</summary>
            {related.map((item) => (
              <article key={item.id}>
                <header>
                  <span>{TYPE_LABELS[item.pageType]}</span>
                  <b>{item.pageTitle}</b>
                </header>
                <p>{item.text}</p>
                {sourceLinks(item)}
              </article>
            ))}
          </details>
        ) : null}
      </div>
    </details>
  );
}

function ToolTrace({ steps }: { steps: readonly AssistantToolStep[] }) {
  if (!steps.length) return null;
  return (
    <ol className="assistant-tool-trace" aria-label="本轮受管工具过程">
      {steps.map((step) => (
        <li key={step.name}>
          <code>{step.name}</code>
          <span>{step.outputSummary}</span>
        </li>
      ))}
    </ol>
  );
}

export default function AssistantSessionPage() {
  const params = useParams<{ sessionId: string }>();
  const { setNotice, spaces } = useWorkspace();
  const sessionId = params.sessionId;
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [turns, setTurns] = useState<
    Array<{
      result: GroundedQueryResult;
      run: AgentRun;
      assistantMessageId: string;
      toolSteps: AssistantToolStep[];
    }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [activeTurn, setActiveTurn] = useState<ActiveTurn | null>(null);
  const [skillState, setSkillState] = useState<SessionSkillState>({ skills: [], approvals: [] });
  const [skillLoading, setSkillLoading] = useState(true);
  const [skillRuns, setSkillRuns] = useState<SkillRun[]>([]);
  const [contextSpaceId, setContextSpaceId] = useState("");
  const [contextScope, setContextScope] = useState<AgentContextScope>("space");
  const [contextTargetId, setContextTargetId] = useState("");
  const [contextOptions, setContextOptions] = useState<ContextOptions>({
    pages: [],
    versions: [],
    courses: []
  });
  const [contextOptionsLoading, setContextOptionsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeBindings = useMemo(
    () => detail?.bindings.filter(({ status }) => status === "active") ?? [],
    [detail]
  );
  const recoveredRunningRun = useMemo(
    () => detail?.runs.find((run) => run.status === "running") ?? null,
    [detail]
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/agent-sessions/${sessionId}`, { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as {
          session?: unknown;
          bindings?: unknown;
          messages?: unknown;
          runs?: unknown;
          toolCalls?: unknown;
          message?: string;
        } | null;
        if (!response.ok) throw new Error(data?.message ?? "会话读取失败");
        const session = agentSessionSummarySchema.parse(data?.session);
        const bindings = agentContextBindingSchema.array().parse(data?.bindings);
        const messages = agentMessageSchema.array().parse(data?.messages);
        const runs = agentRunSchema.array().parse(data?.runs);
        const toolCalls = agentKnowledgeToolCallSchema.array().parse(data?.toolCalls);
        return { session, bindings, messages, runs, toolCalls };
      })
      .then(setDetail)
      .catch((value) => setError(value instanceof Error ? value.message : "会话读取失败"))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [sessionId]);

  const loadSessionSkills = useCallback(
    async (signal?: AbortSignal): Promise<SessionSkillState> => {
      const response = await fetch(
        `/api/agent-sessions/${sessionId}/skills`,
        signal ? { signal } : undefined
      );
      const data = (await response.json().catch(() => null)) as {
        skills?: unknown;
        approvals?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "Skill 状态读取失败");
      return {
        skills: sessionSkillSchema.array().parse(data?.skills),
        approvals: skillApprovalSchema.array().parse(data?.approvals)
      };
    },
    [sessionId]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadSessionSkills(controller.signal)
      .then(setSkillState)
      .catch((value) => setError(value instanceof Error ? value.message : "Skill 状态读取失败"))
      .finally(() => setSkillLoading(false));
    return () => controller.abort();
  }, [loadSessionSkills]);

  useEffect(() => {
    if (!contextSpaceId || contextScope === "space") return;
    const controller = new AbortController();
    void fetch(
      `/api/agent-sessions/${sessionId}/context-options?spaceId=${encodeURIComponent(contextSpaceId)}`,
      { signal: controller.signal }
    )
      .then(async (response) => {
        const data = (await response.json().catch(() => null)) as ContextOptions & {
          message?: string;
        };
        if (!response.ok) throw new Error(data?.message ?? "知识范围候选读取失败");
        return {
          pages: data.pages ?? [],
          versions: data.versions ?? [],
          courses: data.courses ?? []
        };
      })
      .then(setContextOptions)
      .catch((value: unknown) => {
        if (value instanceof Error && value.name === "AbortError") return;
        setError(value instanceof Error ? value.message : "知识范围候选读取失败");
      })
      .finally(() => setContextOptionsLoading(false));
    return () => controller.abort();
  }, [contextScope, contextSpaceId, sessionId]);

  const loadSkillRuns = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(
        `/api/agent-sessions/${sessionId}/skill-runs`,
        signal ? { signal } : undefined
      );
      const data = (await response.json().catch(() => null)) as {
        runs?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "Skill 运行记录读取失败");
      return skillRunSchema.array().parse(data?.runs);
    },
    [sessionId]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadSkillRuns(controller.signal)
      .then(setSkillRuns)
      .catch((value) =>
        setError(value instanceof Error ? value.message : "Skill 运行记录读取失败")
      );
    return () => controller.abort();
  }, [loadSkillRuns]);

  const hasActiveSkillRun = skillRuns.some(
    (run) => run.status === "queued" || run.status === "running"
  );

  useEffect(() => {
    if (!hasActiveSkillRun) return;
    const interval = window.setInterval(() => {
      void loadSkillRuns()
        .then(setSkillRuns)
        .catch(() => undefined);
    }, 2_500);
    return () => window.clearInterval(interval);
  }, [hasActiveSkillRun, loadSkillRuns]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || detail.session.status !== "active") return;
    const form = new FormData(event.currentTarget);
    const message = String(form.get("message") ?? "").trim();
    if (message.length < 2) return;
    setSending(true);
    setError(null);
    setNotice("正在准备本轮有据对话…");
    try {
      const response = await fetch(`/api/agent-sessions/${sessionId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message })
      });
      if (!response.ok || !response.body) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? "本轮对话失败");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      const toolSteps: AssistantToolStep[] = [];
      while (!finished) {
        const read = await reader.read();
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const item of parseSseEvents(blocks.join("\n\n"))) {
          const eventData = agentRunStreamEventSchema.parse(JSON.parse(item.data));
          if (eventData.type === "run.started") {
            setActiveTurn({
              runId: eventData.runId,
              userMessage: eventData.userMessage,
              text: "",
              stage: "starting"
            });
            setDetail((current) =>
              current
                ? { ...current, messages: [...current.messages, eventData.userMessage] }
                : current
            );
          } else if (eventData.type === "tool.requested") {
            const stage = stageForRequestedTool(eventData.tool);
            setActiveTurn((current) => (current ? { ...current, stage } : current));
            setNotice(stage === "reading" ? "正在阅读已检索依据…" : "正在检索已绑定知识范围…");
          } else if (eventData.type === "tool.completed") {
            toolSteps.push({ name: eventData.tool, outputSummary: eventData.outputSummary });
            setActiveTurn((current) => (current ? { ...current, stage: "answering" } : current));
            setNotice("已找到依据，正在生成回答…");
          } else if (eventData.type === "assistant.delta") {
            setActiveTurn((current) =>
              current
                ? { ...current, text: current.text + eventData.text, stage: "answering" }
                : current
            );
          } else if (eventData.type === "run.completed") {
            const result = groundedQueryResultSchema.parse(eventData.result);
            const run = agentRunSchema.parse(eventData.run);
            setDetail((current) =>
              current
                ? {
                    ...current,
                    messages: [
                      ...current.messages,
                      {
                        id: eventData.assistantMessageId,
                        role: "assistant",
                        content: result.answer.answer,
                        createdAt: run.completedAt ?? run.createdAt
                      }
                    ],
                    runs: [...current.runs, run]
                  }
                : current
            );
            setTurns((current) => [
              ...current,
              {
                result,
                run,
                assistantMessageId: eventData.assistantMessageId,
                toolSteps
              }
            ]);
            setActiveTurn(null);
            event.currentTarget.reset();
            setNotice(result.answer.insufficientEvidence ? "本轮依据不足" : "已完成有据回答");
            finished = true;
          } else if (eventData.type === "run.stopped") {
            setActiveTurn(null);
            setNotice("本轮对话已停止");
            finished = true;
          } else if (eventData.type === "run.failed") {
            setActiveTurn(null);
            setError(eventData.message);
            setNotice("本轮对话失败");
            finished = true;
          }
        }
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : "本轮对话失败，请稍后重试");
      setNotice("对话失败");
    } finally {
      setSending(false);
    }
  }

  async function stopCurrentRun(target = activeTurn) {
    if (!target) return;
    try {
      const response = await fetch(`/api/agent-runs/${target.runId}/stop`, { method: "POST" });
      const data = (await response.json().catch(() => null)) as {
        run?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "停止对话失败");
      const run = agentRunSchema.parse(data?.run);
      setDetail((current) =>
        current
          ? {
              ...current,
              runs: current.runs.map((value) => (value.id === run.id ? run : value))
            }
          : current
      );
      setNotice("已请求停止本轮对话");
    } catch (value) {
      setError(value instanceof Error ? value.message : "停止对话失败");
    }
  }

  async function updateSession(status: "active" | "archived") {
    const response = await fetch(`/api/agent-sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status })
    });
    if (!response.ok) {
      setError("会话状态更新失败");
      return;
    }
    setDetail((current) =>
      current ? { ...current, session: { ...current.session, status } } : current
    );
    setNotice(status === "archived" ? "会话已归档" : "会话已恢复");
  }

  async function addContextBinding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || detail.session.status !== "active") return;
    if (!contextSpaceId || (contextScope !== "space" && !contextTargetId)) return;
    setError(null);
    try {
      const response = await fetch(`/api/agent-sessions/${sessionId}/context-bindings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spaceId: contextSpaceId,
          scope: contextScope,
          ...(contextScope === "space" ? {} : { targetId: contextTargetId })
        })
      });
      const data = (await response.json().catch(() => null)) as {
        binding?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "添加知识范围失败");
      const binding = agentContextBindingSchema.parse(data?.binding);
      setDetail((current) =>
        current ? { ...current, bindings: [...current.bindings, binding] } : current
      );
      setContextSpaceId("");
      setContextScope("space");
      setContextTargetId("");
      setNotice("知识范围已添加，将从下一轮开始生效");
    } catch (value) {
      setError(value instanceof Error ? value.message : "添加知识范围失败");
    }
  }

  async function removeContextBinding(binding: AgentContextBinding) {
    if (!detail || binding.status !== "active") return;
    setError(null);
    try {
      const response = await fetch(
        `/api/agent-sessions/${sessionId}/context-bindings/${binding.id}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? "移除知识范围失败");
      }
      setDetail((current) =>
        current
          ? {
              ...current,
              bindings: current.bindings.map((item) =>
                item.id === binding.id ? { ...item, status: "removed" } : item
              )
            }
          : current
      );
      setNotice("知识范围已移除，将不参与下一轮回答");
    } catch (value) {
      setError(value instanceof Error ? value.message : "移除知识范围失败");
    }
  }

  async function requestSkillApproval(skill: SessionSkill) {
    if (!detail || skill.decision !== "ask" || skill.execution !== "worker") return;
    const bindings = skillBindings(skill, activeBindings);
    if (skill.permissions.resources !== "none" && !bindings.length) return;
    setError(null);
    try {
      const response = await fetch(`/api/agent-sessions/${sessionId}/skill-approvals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          skillId: skill.id,
          bindingIds: bindings.map(({ id }) => id),
          inputSummary: skillInputSummary(skill, bindings.length)
        })
      });
      const data = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(data?.message ?? "请求 Skill 确认失败");
      setSkillState(await loadSessionSkills());
      setNotice("已创建 Skill 确认请求");
    } catch (value) {
      setError(value instanceof Error ? value.message : "请求 Skill 确认失败");
    }
  }

  async function decideSkillApproval(approval: SkillApproval, decision: "approve" | "reject") {
    setError(null);
    try {
      const response = await fetch(`/api/agent-approvals/${approval.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision })
      });
      const data = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(data?.message ?? "处理 Skill 确认失败");
      setSkillState(await loadSessionSkills());
      setNotice(decision === "approve" ? "已确认，等待安全运行时接入" : "已拒绝此 Skill 请求");
    } catch (value) {
      setError(value instanceof Error ? value.message : "处理 Skill 确认失败");
    }
  }

  async function queueSkillRun(skill: SessionSkill) {
    if (!detail || skill.execution !== "worker") return;
    const bindings = skillBindings(skill, activeBindings);
    if (skill.permissions.resources !== "none" && !bindings.length) return;
    setError(null);
    try {
      const response = await fetch(`/api/agent-sessions/${sessionId}/skill-runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          skillId: skill.id,
          bindingIds: bindings.map(({ id }) => id),
          inputSummary: skillInputSummary(skill, bindings.length)
        })
      });
      const data = (await response.json().catch(() => null)) as {
        run?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "加入 Skill 队列失败");
      const run = skillRunSchema.parse(data?.run);
      setSkillRuns((current) => [...current, run]);
      setNotice("Skill 请求已安全排队，尚未执行");
    } catch (value) {
      setError(value instanceof Error ? value.message : "加入 Skill 队列失败");
    }
  }

  if (loading) return <p className="empty">正在读取会话…</p>;
  if (!detail) {
    return (
      <section className="panel">
        <p className="form-error">{error ?? "会话不存在或无权访问"}</p>
        <Link href="/workspace/assistant">返回对话助手</Link>
      </section>
    );
  }

  return (
    <section className="assistant-session">
      <header className="assistant-session-head">
        <div>
          <Link href="/workspace/assistant">← 全部会话</Link>
          <h2>{detail.session.title}</h2>
          <p>
            {detail.session.status === "active"
              ? "只在右侧列出的受管知识范围中检索。"
              : "该会话已归档；历史消息和来源仍可查看。"}
          </p>
        </div>
        <button
          className="quiet-action"
          onClick={() =>
            void updateSession(detail.session.status === "active" ? "archived" : "active")
          }
        >
          {detail.session.status === "active" ? "归档会话" : "恢复会话"}
        </button>
      </header>
      {error ? <p className="form-error">{error}</p> : null}
      <div className="assistant-workbench">
        <main className="assistant-thread" aria-label="对话消息">
          {detail.messages.length ? (
            detail.messages.map((message) => {
              const currentRun = detail.runs.find((run) => run.assistantMessageId === message.id);
              const historicalToolSteps = currentRun
                ? toolStepsForRun(detail.toolCalls, currentRun.id)
                : [];
              const turn = turns.find((entry) => entry.assistantMessageId === message.id);
              return (
                <article key={message.id} className={`assistant-message ${message.role}`}>
                  <header>
                    <span>{message.role === "user" ? "你" : "助手"}</span>
                    <time>
                      {new Date(message.createdAt).toLocaleString("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit"
                      })}
                    </time>
                  </header>
                  <p>{message.content}</p>
                  <ToolTrace steps={turn?.toolSteps ?? historicalToolSteps} />
                  {turn ? <TurnSources result={turn.result} /> : null}
                  {currentRun && !turn ? (
                    <details className="assistant-turn-sources">
                      <summary>本轮来源 · {currentRun.evidence.length} 条已保存证据</summary>
                      <div className="assistant-source-list">
                        {currentRun.evidence.map((evidence) => (
                          <article key={evidence.id}>
                            <header>
                              <span>{TYPE_LABELS[evidence.pageType]}</span>
                              <b>{evidence.pageTitle}</b>
                            </header>
                            <p>历史会话只保存来源身份与定位数量，不重复保存知识正文。</p>
                            <div className="assistant-source-links">
                              {evidence.sourceRefs.slice(0, 3).map((ref, index) => (
                                <a
                                  key={ref}
                                  href={sourceHref(ref)}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  原资料 {String(index + 1).padStart(2, "0")} ↗
                                </a>
                              ))}
                            </div>
                          </article>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </article>
              );
            })
          ) : (
            <div className="assistant-empty-thread">
              <b>开始第一轮对话</b>
              <p>先检索已绑定 Wiki，再返回自然语言回答；来源资料会单独显示。</p>
            </div>
          )}
          {activeTurn ? (
            <article className="assistant-message assistant active" aria-live="polite">
              <header>
                <span>助手 · {assistantStageLabel(activeTurn.stage)}</span>
                <button className="quiet-action" onClick={() => void stopCurrentRun()}>
                  停止
                </button>
              </header>
              <p>
                {activeTurn.text ||
                  (activeTurn.stage === "searching"
                    ? "正在检索已绑定知识范围…"
                    : activeTurn.stage === "reading"
                      ? "正在阅读已检索依据…"
                      : "正在准备有据回答…")}
              </p>
            </article>
          ) : null}
          {!activeTurn && recoveredRunningRun ? (
            <article className="assistant-message assistant active" aria-live="polite">
              <header>
                <span>助手 · 此轮仍在运行</span>
                <button
                  className="quiet-action"
                  onClick={() =>
                    void stopCurrentRun({
                      runId: recoveredRunningRun.id,
                      userMessage: null,
                      text: "",
                      stage: "starting"
                    })
                  }
                >
                  停止
                </button>
              </header>
              <p>页面已恢复；新的浏览器不会重放此前输出，但你仍可以停止本轮。</p>
            </article>
          ) : null}
          <form className="assistant-composer" onSubmit={sendMessage}>
            <textarea
              name="message"
              minLength={2}
              required
              disabled={
                sending ||
                Boolean(recoveredRunningRun) ||
                detail.session.status !== "active" ||
                !activeBindings.length
              }
              placeholder={
                activeBindings.length ? "基于已绑定知识范围提问…" : "当前没有可用的知识范围"
              }
            />
            <button
              disabled={
                sending ||
                Boolean(recoveredRunningRun) ||
                detail.session.status !== "active" ||
                !activeBindings.length
              }
            >
              {sending ? "正在运行…" : "发送 ↗"}
            </button>
          </form>
        </main>
        <aside className="assistant-context-panel">
          <header>
            <p>本会话知识范围</p>
            <h3>{activeBindings.length} 个可用范围</h3>
          </header>
          <ul>
            {detail.bindings.map((binding) => (
              <li key={binding.id} className={binding.status}>
                <div className="assistant-context-item-head">
                  <b>{binding.label}</b>
                  {binding.status === "active" && detail.session.status === "active" ? (
                    <button
                      className="quiet-action assistant-context-remove"
                      onClick={() => void removeContextBinding(binding)}
                    >
                      移除
                    </button>
                  ) : null}
                </div>
                <code>{binding.virtualPath}</code>
                <small>
                  {binding.status === "active"
                    ? "已授权，可用于下一轮"
                    : binding.status === "revoked"
                      ? "权限已撤销，不再用于新回答"
                      : "已移除，不再用于新回答"}
                </small>
              </li>
            ))}
          </ul>
          {detail.session.status === "active" && spaces.length ? (
            <form className="assistant-context-form" onSubmit={addContextBinding}>
              <label htmlFor="assistant-context-space">添加知识范围</label>
              <div>
                <select
                  id="assistant-context-space"
                  value={contextSpaceId}
                  onChange={(event) => {
                    const nextSpaceId = event.target.value;
                    setContextSpaceId(nextSpaceId);
                    setContextTargetId("");
                    setContextOptions({ pages: [], versions: [], courses: [] });
                    setContextOptionsLoading(Boolean(nextSpaceId) && contextScope !== "space");
                  }}
                >
                  <option value="" disabled>
                    选择一个已授权空间
                  </option>
                  {spaces.map(({ space }) => (
                    <option key={space.id} value={space.id}>
                      {space.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="知识范围类型"
                  value={contextScope}
                  onChange={(event) => {
                    const nextScope = event.target.value as AgentContextScope;
                    setContextScope(nextScope);
                    setContextTargetId("");
                    setContextOptions({ pages: [], versions: [], courses: [] });
                    setContextOptionsLoading(Boolean(contextSpaceId) && nextScope !== "space");
                  }}
                  disabled={!contextSpaceId}
                >
                  <option value="space">整个知识空间</option>
                  <option value="wiki_page">指定 Wiki 页面</option>
                  <option value="resource_version">指定资料版本</option>
                  <option value="course">已确认学习课程</option>
                </select>
              </div>
              {contextScope !== "space" ? (
                <select
                  aria-label="知识范围目标"
                  value={contextTargetId}
                  onChange={(event) => setContextTargetId(event.target.value)}
                  disabled={!contextSpaceId || contextOptionsLoading}
                >
                  <option value="" disabled>
                    {contextOptionsLoading
                      ? "正在读取候选…"
                      : contextScope === "wiki_page"
                        ? "选择已发布 Wiki 页面"
                        : contextScope === "resource_version"
                          ? "选择已完成处理的资料版本"
                          : "选择已确认课程"}
                  </option>
                  {(contextScope === "wiki_page"
                    ? contextOptions.pages
                    : contextScope === "resource_version"
                      ? contextOptions.versions
                      : contextOptions.courses
                  ).map((option) => (
                    <option key={option.id} value={option.id}>
                      {"title" in option ? option.title : option.label}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                disabled={
                  !contextSpaceId ||
                  (contextScope !== "space" && (!contextTargetId || contextOptionsLoading))
                }
              >
                添加
              </button>
            </form>
          ) : null}
          <p className="assistant-context-note">
            路径由系统生成。模型不会读取服务器、本机或 Blob 的真实文件路径。
          </p>
          <section className="assistant-skill-panel" aria-label="可用工具与 Skill">
            <header>
              <p>可用工具与 Skill</p>
              <small>{skillLoading ? "读取中…" : `${skillState.skills.length} 项可请求`}</small>
            </header>
            {skillState.skills.length ? (
              <ul>
                {skillState.skills.map((skill) => (
                  <li key={skill.id}>
                    <div>
                      <b>{skill.id}</b>
                      <small>{skill.description}</small>
                      <small>{skillExecutionLabel(skill)}</small>
                    </div>
                    {skill.execution === "conversation" ? (
                      <span className="assistant-skill-state">本轮问答自动使用</span>
                    ) : skill.execution === "unavailable" ? (
                      <span className="assistant-skill-state">安全执行器待接入</span>
                    ) : skill.decision === "allow" ? (
                      <button
                        className="skill-decision allow"
                        disabled={detail.session.status !== "active"}
                        onClick={() => void queueSkillRun(skill)}
                      >
                        加入安全队列
                      </button>
                    ) : (
                      <button
                        className="quiet-action assistant-context-remove"
                        disabled={detail.session.status !== "active"}
                        onClick={() => void requestSkillApproval(skill)}
                      >
                        请求确认
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="assistant-context-note">当前没有可向会话暴露的 Skill。</p>
            )}
            {skillState.approvals.length ? (
              <div className="assistant-approval-list">
                {skillState.approvals.map((approval) => (
                  <article key={approval.id}>
                    <b>{approval.skillId}</b>
                    <p>{approval.inputSummary}</p>
                    <small>
                      {approval.status === "pending"
                        ? `等待确认 · ${new Date(approval.expiresAt).toLocaleTimeString("zh-CN", {
                            hour: "2-digit",
                            minute: "2-digit"
                          })} 前有效`
                        : approval.status === "approved"
                          ? "已确认 · 等待安全运行时接入"
                          : approval.status === "rejected"
                            ? "已拒绝"
                            : "已过期"}
                    </small>
                    {approval.status === "pending" && detail.session.status === "active" ? (
                      <div>
                        <button onClick={() => void decideSkillApproval(approval, "approve")}>
                          批准
                        </button>
                        <button
                          className="quiet-action"
                          onClick={() => void decideSkillApproval(approval, "reject")}
                        >
                          拒绝
                        </button>
                      </div>
                    ) : null}
                    {approval.status === "approved" && detail.session.status === "active" ? (
                      <button
                        onClick={() => {
                          const skill = skillState.skills.find(({ id }) => id === approval.skillId);
                          if (skill?.execution === "worker") void queueSkillRun(skill);
                        }}
                      >
                        加入安全队列
                      </button>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : null}
            {skillRuns.length ? (
              <div className="assistant-skill-run-list">
                {skillRuns.map((run) => (
                  <article key={run.id}>
                    <b>{run.skillId}</b>
                    <small>{skillRunStatusLabel(run)}</small>
                    {completedSkillRunSummary(run) ? (
                      <p className="assistant-skill-run-summary">{completedSkillRunSummary(run)}</p>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : null}
            <p className="assistant-context-note">
              <code>wiki-query</code> 是本轮对话的受管内置能力；<code>wiki-lint</code>
              与组织已受管安装的固定 CLI 可由 Worker
              执行。它们不能读取原始文件、使用模型或出网；学习生成 Skill 仅能从学习页面发起。
            </p>
          </section>
        </aside>
      </div>
    </section>
  );
}
