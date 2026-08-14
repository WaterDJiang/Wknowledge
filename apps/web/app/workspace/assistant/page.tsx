"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import type {
  AgentContextScope,
  AgentSessionSummary,
  CreateAgentContextBindingInput
} from "@wknowledge/contracts";
import { useWorkspace } from "../workspace-shell";

interface ContextOptions {
  pages: Array<{ id: string; title: string; type: string }>;
  versions: Array<{ id: string; label: string; originalName: string }>;
  courses: Array<{ id: string; label: string }>;
}

interface DraftBinding {
  input: CreateAgentContextBindingInput;
  label: string;
}

export default function AssistantPage() {
  const router = useRouter();
  const { activeId, setNotice, spaces } = useWorkspace();
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [draftBindings, setDraftBindings] = useState<DraftBinding[]>([]);
  const [contextSpaceId, setContextSpaceId] = useState("");
  const [contextScope, setContextScope] = useState<AgentContextScope>("space");
  const [contextTargetId, setContextTargetId] = useState("");
  const [contextOptions, setContextOptions] = useState<ContextOptions>({
    pages: [],
    versions: [],
    courses: []
  });
  const [contextOptionsLoading, setContextOptionsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/agent-sessions", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("AGENT_SESSION_LIST_FAILED");
        return response.json() as Promise<{ sessions: AgentSessionSummary[] }>;
      })
      .then(({ sessions: values }) => setSessions(values))
      .catch((value: unknown) => {
        if (value instanceof Error && value.name === "AbortError") return;
        setError("会话列表暂时无法读取");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const activeSpace = spaces.find(({ space }) => space.id === activeId)?.space ?? null;

  useEffect(() => {
    if (!contextSpaceId || contextScope === "space") return;
    const controller = new AbortController();
    void fetch(`/api/agent-context-options?spaceId=${encodeURIComponent(contextSpaceId)}`, {
      signal: controller.signal
    })
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
  }, [contextScope, contextSpaceId]);

  function addDraftBinding() {
    if (!contextSpaceId || draftBindings.length >= 8) return;
    if (contextScope !== "space" && !contextTargetId) return;
    const next =
      contextScope === "space"
        ? ({ spaceId: contextSpaceId, scope: "space" } as const)
        : ({ spaceId: contextSpaceId, scope: contextScope, targetId: contextTargetId } as const);
    const duplicate = draftBindings.some(
      ({ input }) =>
        input.spaceId === next.spaceId &&
        input.scope === next.scope &&
        ("targetId" in input ? input.targetId : undefined) ===
          ("targetId" in next ? next.targetId : undefined)
    );
    if (duplicate) {
      setError("该知识范围已在本次上下文中");
      return;
    }
    const option =
      contextScope === "wiki_page"
        ? contextOptions.pages.find(({ id }) => id === contextTargetId)?.title
        : contextScope === "resource_version"
          ? contextOptions.versions.find(({ id }) => id === contextTargetId)?.label
          : contextScope === "course"
            ? contextOptions.courses.find(({ id }) => id === contextTargetId)?.label
            : null;
    const space = spaces.find(({ space: value }) => value.id === contextSpaceId)?.space;
    setDraftBindings((current) => [
      ...current,
      {
        input: next,
        label:
          contextScope === "space"
            ? (space?.name ?? "已授权知识空间")
            : `${space?.name ?? "已授权知识空间"} · ${option ?? "指定范围"}`
      }
    ]);
    setContextSpaceId("");
    setContextScope("space");
    setContextTargetId("");
    setContextOptions({ pages: [], versions: [], courses: [] });
    setError(null);
  }

  async function createSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draftBindings.length) return;
    setCreating(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/agent-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: form.get("title"),
          bindings: draftBindings.map(({ input }) => input)
        })
      });
      const data = (await response.json().catch(() => null)) as {
        session?: AgentSessionSummary;
        message?: string;
      } | null;
      if (!response.ok || !data?.session) throw new Error(data?.message ?? "创建会话失败");
      setNotice("对话会话已创建");
      router.push(`/workspace/assistant/${data.session.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : "创建会话失败，请稍后重试");
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="assistant-start">
      <div className="assistant-intro">
        <span>04</span>
        <div>
          <h2>从指定知识范围开始对话</h2>
          <p>
            先加入本次对话的知识范围。系统只会在这些受管范围中检索，且不会暴露服务器或本机文件位置。
          </p>
        </div>
      </div>
      <div className="assistant-start-grid">
        <form className="assistant-create" onSubmit={createSession}>
          <label>
            <span>会话名称</span>
            <input
              name="title"
              defaultValue="新的知识对话"
              minLength={1}
              maxLength={120}
              required
            />
          </label>
          <fieldset>
            <legend>本次对话的知识范围</legend>
            <p>加入 1–8 项范围。指定页面、资料版本或课程不会隐式扩展为整个知识空间。</p>
            <div className="assistant-context-builder">
              <select
                aria-label="知识空间"
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
                  选择已授权空间{activeSpace ? `（当前：${activeSpace.name}）` : ""}
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
                disabled={!contextSpaceId}
                onChange={(event) => {
                  const nextScope = event.target.value as AgentContextScope;
                  setContextScope(nextScope);
                  setContextTargetId("");
                  setContextOptions({ pages: [], versions: [], courses: [] });
                  setContextOptionsLoading(Boolean(contextSpaceId) && nextScope !== "space");
                }}
              >
                <option value="space">整个知识空间</option>
                <option value="wiki_page">指定 Wiki 页面</option>
                <option value="resource_version">指定资料版本</option>
                <option value="course">已确认学习课程</option>
              </select>
              {contextScope !== "space" ? (
                <select
                  aria-label="知识范围目标"
                  value={contextTargetId}
                  disabled={!contextSpaceId || contextOptionsLoading}
                  onChange={(event) => setContextTargetId(event.target.value)}
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
                type="button"
                className="button-secondary"
                onClick={addDraftBinding}
                disabled={
                  !contextSpaceId ||
                  draftBindings.length >= 8 ||
                  contextOptionsLoading ||
                  (contextScope !== "space" && !contextTargetId)
                }
              >
                加入本次上下文
              </button>
            </div>
            {draftBindings.length ? (
              <ul className="assistant-initial-bindings">
                {draftBindings.map(({ input: binding, label }) => {
                  const path =
                    binding.scope === "space"
                      ? `/knowledge/${binding.spaceId}`
                      : binding.scope === "wiki_page"
                        ? `/knowledge/${binding.spaceId}/wiki/pages/${binding.targetId}`
                        : binding.scope === "resource_version"
                          ? `/knowledge/${binding.spaceId}/resources/${binding.targetId}`
                          : `/knowledge/${binding.spaceId}/courses/${binding.targetId}`;
                  return (
                    <li
                      key={`${binding.spaceId}:${binding.scope}:${"targetId" in binding ? binding.targetId : ""}`}
                    >
                      <span>
                        <b>{label}</b>
                        <small>{path}</small>
                      </span>
                      <button
                        type="button"
                        className="quiet-action"
                        onClick={() =>
                          setDraftBindings((current) =>
                            current.filter(({ input }) => input !== binding)
                          )
                        }
                      >
                        移除
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="assistant-context-note">
                请先加入至少一个知识范围；不会默认读取整个空间。
              </p>
            )}
          </fieldset>
          {error ? <p className="form-error">{error}</p> : null}
          <button disabled={creating || !draftBindings.length}>
            {creating ? "正在创建…" : "创建并开始对话 ↗"}
          </button>
        </form>
        <aside className="assistant-session-list" aria-label="已有对话">
          <header>
            <div>
              <p>最近会话</p>
              <h3>继续已有对话</h3>
            </div>
            <small>{loading ? "读取中" : `${sessions.length} 个`}</small>
          </header>
          {sessions.length ? (
            <ul>
              {sessions.map((session) => (
                <li key={session.id}>
                  <Link href={`/workspace/assistant/${session.id}`}>
                    <span>
                      <b>{session.title}</b>
                      <small>
                        {session.bindingCount} 个知识空间 ·{" "}
                        {session.status === "archived" ? "已归档" : "进行中"}
                      </small>
                    </span>
                    <i>↗</i>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">创建后，这里会保留你的会话与知识范围。</p>
          )}
        </aside>
      </div>
    </section>
  );
}
