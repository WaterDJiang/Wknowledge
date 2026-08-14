"use client";

import { useEffect, useState, type FormEvent } from "react";
import { manualFreeResponseReviewItemSchema } from "@wknowledge/contracts";
import type {
  ApiError,
  ManagedModelProvider,
  ManagedQueryRun,
  ManagedSkill,
  ManualFreeResponseReviewItem
} from "@wknowledge/contracts";
import { useWorkspace } from "../workspace-shell";
import { AccessManagement } from "../access-management";
import { AuditExport } from "../audit-export";
import { BlobAudit } from "../blob-audit";
import { QueueHealth } from "../queue-health";
import { OperationsHealth } from "../operations-health";
import { ModelBudget } from "../model-budget";
import { StorageUsagePanel } from "../storage-usage";
import { FreeResponseReviewQueue } from "../free-response-review";

const HEALTH_LABELS: Record<ManagedModelProvider["health"], string> = {
  unknown: "未测试",
  healthy: "可用",
  unhealthy: "不可用"
};

const CAPABILITY_LABELS: Record<string, string> = {
  chat: "对话模型",
  vision: "视觉理解",
  speech_to_text: "语音转文字"
};

const RUN_MODE_LABELS: Record<ManagedQueryRun["answerMode"], string> = {
  generated: "模型生成",
  extractive_fallback: "检索摘要"
};

function formatRunTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

async function errorMessage(response: Response, fallback: string) {
  const error = (await response.json().catch(() => null)) as ApiError | null;
  return error?.message ?? fallback;
}

function ProviderCard({
  provider,
  busy,
  onToggle,
  onTest,
  onEdit
}: {
  provider: ManagedModelProvider;
  busy: boolean;
  onToggle: (provider: ManagedModelProvider) => Promise<void>;
  onTest: (provider: ManagedModelProvider) => Promise<void>;
  onEdit: (provider: ManagedModelProvider) => void;
}) {
  return (
    <article className="settings-card provider-card">
      <header>
        <div>
          <span className={`health-dot ${provider.health}`} />
          <div>
            <h3>{provider.name}</h3>
            <p>{provider.location === "local" ? "本地服务" : "云端服务"}</p>
          </div>
        </div>
        <span className={`status-chip ${provider.enabled ? "enabled" : "disabled"}`}>
          {provider.enabled ? "已启用" : "已停用"}
        </span>
      </header>
      <dl className="settings-facts">
        <div>
          <dt>模型</dt>
          <dd>{provider.model}</dd>
        </div>
        <div>
          <dt>能力</dt>
          <dd>
            {provider.capabilities.map((capability) => CAPABILITY_LABELS[capability]).join(" · ")}
          </dd>
        </div>
        <div>
          <dt>地址</dt>
          <dd>{provider.baseUrl}</dd>
        </div>
        <div>
          <dt>凭据</dt>
          <dd>{provider.hasApiKey ? "已安全保存" : "无需密钥"}</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>{HEALTH_LABELS[provider.health]}</dd>
        </div>
      </dl>
      <footer>
        <button className="button-secondary" disabled={busy} onClick={() => void onTest(provider)}>
          测试连接
        </button>
        <button className="button-quiet" disabled={busy} onClick={() => onEdit(provider)}>
          编辑配置
        </button>
        <button className="button-quiet" disabled={busy} onClick={() => void onToggle(provider)}>
          {provider.enabled ? "停用" : "启用"}
        </button>
      </footer>
    </article>
  );
}

function SkillCard({
  skill,
  busy,
  onToggle
}: {
  skill: ManagedSkill;
  busy: boolean;
  onToggle: (skill: ManagedSkill) => Promise<void>;
}) {
  const network = skill.permissions.network === "deny" ? "禁止出网" : "网络白名单";
  const originLabel = skill.origin === "installed" ? "受管 CLI · 等待 Linux 沙箱" : "内置 Skill";
  return (
    <article className="settings-card skill-card">
      <header>
        <div>
          <span className="skill-mark">SK</span>
          <div>
            <h3>{skill.id}</h3>
            <p>
              v{skill.version} · {originLabel}
            </p>
          </div>
        </div>
        <button
          className={`toggle-switch ${skill.enabled ? "on" : ""}`}
          role="switch"
          aria-checked={skill.enabled}
          aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.id}`}
          disabled={busy}
          onClick={() => void onToggle(skill)}
        >
          <span />
        </button>
      </header>
      <p className="settings-description">{skill.description}</p>
      <div className="permission-tags">
        <span>{skill.origin === "installed" ? "受管安装" : "内置"}</span>
        <span>{network}</span>
        <span>{skill.permissions.filesystem === "read" ? "只读文件" : "可写产物"}</span>
        <span>{skill.permissions.approval === "always" ? "每次审批" : "无需审批"}</span>
        {skill.requiredCapabilities.map((capability) => (
          <span key={capability}>{CAPABILITY_LABELS[capability] ?? capability}</span>
        ))}
      </div>
      <footer className="skill-limits">
        <span>{skill.limits.timeoutSeconds}s 超时</span>
        <span>{skill.limits.memoryMb}MB</span>
        <span>{skill.limits.maxModelCalls} 次模型调用</span>
      </footer>
    </article>
  );
}

export default function SettingsPage() {
  const { setNotice } = useWorkspace();
  const [providers, setProviders] = useState<ManagedModelProvider[]>([]);
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [queryRuns, setQueryRuns] = useState<ManagedQueryRun[]>([]);
  const [freeResponseReviews, setFreeResponseReviews] = useState<ManualFreeResponseReviewItem[]>(
    []
  );
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [editingProvider, setEditingProvider] = useState<ManagedModelProvider | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/settings/model-providers", { signal: controller.signal }),
      fetch("/api/settings/skills", { signal: controller.signal }),
      fetch("/api/settings/query-runs?limit=20", { signal: controller.signal }),
      fetch("/api/learning/reviews/free-response", { signal: controller.signal })
    ])
      .then(async ([providerResponse, skillResponse, runResponse, reviewResponse]) => {
        if (!providerResponse.ok || !skillResponse.ok || !runResponse.ok || !reviewResponse.ok)
          throw new Error(
            providerResponse.status === 403 ||
              skillResponse.status === 403 ||
              runResponse.status === 403 ||
              reviewResponse.status === 403
              ? "只有组织管理员可以管理系统设置"
              : "设置读取失败"
          );
        return Promise.all([
          providerResponse.json() as Promise<{ providers: ManagedModelProvider[] }>,
          skillResponse.json() as Promise<{ skills: ManagedSkill[] }>,
          runResponse.json() as Promise<{ runs: ManagedQueryRun[] }>,
          reviewResponse.json() as Promise<{ items: unknown }>
        ]);
      })
      .then(([providerData, skillData, runData, reviewData]) => {
        setProviders(providerData.providers);
        setSkills(skillData.skills);
        setQueryRuns(runData.runs);
        setFreeResponseReviews(manualFreeResponseReviewItemSchema.array().parse(reviewData.items));
        setNotice("系统设置已加载");
      })
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "设置读取失败");
        setNotice("设置读取失败");
      });
    return () => controller.abort();
  }, [setNotice]);

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusyId("create-provider");
    setError("");
    const response = await fetch(
      editingProvider
        ? `/api/settings/model-providers/${editingProvider.id}`
        : "/api/settings/model-providers",
      {
        method: editingProvider ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          capabilities: form.getAll("capabilities"),
          location: form.get("location"),
          baseUrl: form.get("baseUrl"),
          model: form.get("model"),
          apiKey: form.get("apiKey") || undefined,
          ...(editingProvider ? {} : { enabled: true }),
          timeoutMs: 20_000
        })
      }
    );
    if (!response.ok) {
      setError(await errorMessage(response, "模型服务保存失败"));
      setBusyId("");
      return;
    }
    const data = (await response.json()) as { provider: ManagedModelProvider };
    setProviders((current) =>
      editingProvider
        ? current.map((item) => (item.id === data.provider.id ? data.provider : item))
        : [data.provider, ...current]
    );
    const wasEditing = Boolean(editingProvider);
    setEditingProvider(null);
    formElement.reset();
    setBusyId("");
    setNotice(wasEditing ? "模型服务配置已更新" : "模型服务已保存，建议立即测试连接");
  }

  async function toggleProvider(provider: ManagedModelProvider) {
    setBusyId(provider.id);
    const response = await fetch(`/api/settings/model-providers/${provider.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !provider.enabled })
    });
    if (response.ok) {
      const data = (await response.json()) as { provider: ManagedModelProvider };
      setProviders((current) =>
        current.map((item) => (item.id === provider.id ? data.provider : item))
      );
      setNotice(data.provider.enabled ? "模型服务已启用" : "模型服务已停用");
    } else setError(await errorMessage(response, "模型服务更新失败"));
    setBusyId("");
  }

  async function testProvider(provider: ManagedModelProvider) {
    setBusyId(provider.id);
    setNotice("正在测试模型服务…");
    const response = await fetch(`/api/settings/model-providers/${provider.id}/test`, {
      method: "POST"
    });
    if (response.ok) {
      const data = (await response.json()) as { provider: ManagedModelProvider };
      setProviders((current) =>
        current.map((item) => (item.id === provider.id ? data.provider : item))
      );
      setNotice(data.provider.health === "healthy" ? "模型服务连接正常" : "模型服务不可用");
    } else setError(await errorMessage(response, "模型服务测试失败"));
    setBusyId("");
  }

  async function toggleSkill(skill: ManagedSkill) {
    setBusyId(skill.id);
    const response = await fetch(`/api/settings/skills/${skill.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !skill.enabled })
    });
    if (response.ok) {
      const data = (await response.json()) as { skill: ManagedSkill };
      setSkills((current) => current.map((item) => (item.id === skill.id ? data.skill : item)));
      setNotice(data.skill.enabled ? `${skill.id} 已启用` : `${skill.id} 已停用`);
    } else setError(await errorMessage(response, "Skill 状态更新失败"));
    setBusyId("");
  }

  async function reviewFreeResponse(
    item: ManualFreeResponseReviewItem,
    score: number,
    rationale: string
  ) {
    setBusyId(item.attemptId);
    try {
      const response = await fetch(`/api/learning/reviews/free-response/${item.attemptId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptType: item.attemptType, score, rationale })
      });
      if (!response.ok) throw new Error(await errorMessage(response, "人工评分保存失败"));
      setFreeResponseReviews((current) =>
        current.filter(
          (value) => !(value.attemptId === item.attemptId && value.attemptType === item.attemptType)
        )
      );
      setNotice("人工评分已保存；原始作答、量表和来源仍保持不变");
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="settings-page">
      {error ? (
        <div className="settings-error" role="alert">
          {error}
        </div>
      ) : null}
      <section className="panel settings-panel" aria-labelledby="provider-heading">
        <div className="panel-head settings-panel-head">
          <div>
            <span>01</span>
            <h2 id="provider-heading">模型服务</h2>
          </div>
          <small>Provider Registry · server-side secrets</small>
        </div>
        <div className="settings-intro">
          <p>接入 OpenAI-compatible 对话或语音转写服务。健康且启用的配置按能力进入受控路由。</p>
          <b>
            {providers.filter((item) => item.enabled && item.health === "healthy").length} 个可用
          </b>
        </div>
        <form
          key={editingProvider?.id ?? "new-provider"}
          className="provider-create"
          onSubmit={saveProvider}
        >
          <label>
            显示名称
            <input
              name="name"
              placeholder="本地 Ollama"
              defaultValue={editingProvider?.name}
              required
              minLength={1}
            />
          </label>
          <label>
            部署位置
            <select name="location" defaultValue={editingProvider?.location ?? "local"}>
              <option value="local">本地</option>
              <option value="cloud">云端</option>
            </select>
          </label>
          <label className="provider-url-field">
            接口地址
            <input
              name="baseUrl"
              type="url"
              placeholder="http://127.0.0.1:11434/v1"
              defaultValue={editingProvider?.baseUrl}
              required
            />
          </label>
          <label>
            模型名称
            <input
              name="model"
              placeholder="qwen3"
              defaultValue={editingProvider?.model}
              required
            />
          </label>
          <fieldset className="provider-capabilities">
            <legend>服务能力</legend>
            <label>
              <input
                name="capabilities"
                type="checkbox"
                value="chat"
                defaultChecked={editingProvider?.capabilities.includes("chat") ?? true}
              />
              对话
            </label>
            <label>
              <input
                name="capabilities"
                type="checkbox"
                value="speech_to_text"
                defaultChecked={editingProvider?.capabilities.includes("speech_to_text") ?? false}
              />
              语音转文字
            </label>
            <label>
              <input
                name="capabilities"
                type="checkbox"
                value="vision"
                defaultChecked={editingProvider?.capabilities.includes("vision") ?? false}
              />
              视觉理解
            </label>
          </fieldset>
          <label>
            API Key（可选）
            <input
              name="apiKey"
              type="password"
              autoComplete="new-password"
              placeholder={editingProvider?.hasApiKey ? "留空则保留已保存密钥" : "仅服务端加密保存"}
            />
          </label>
          <button disabled={busyId === "create-provider"}>
            {busyId === "create-provider"
              ? "保存中…"
              : editingProvider
                ? "保存修改"
                : "添加模型服务"}
          </button>
          {editingProvider ? (
            <button type="button" className="button-quiet" onClick={() => setEditingProvider(null)}>
              取消
            </button>
          ) : null}
        </form>
        <div className="settings-grid provider-grid">
          {providers.length ? (
            providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                busy={busyId === provider.id}
                onToggle={toggleProvider}
                onTest={testProvider}
                onEdit={setEditingProvider}
              />
            ))
          ) : (
            <p className="settings-empty">
              尚未添加模型服务。未配置时知识问答继续使用检索摘要模式。
            </p>
          )}
        </div>
      </section>

      <section className="panel settings-panel" aria-labelledby="skill-heading">
        <div className="panel-head settings-panel-head">
          <div>
            <span>02</span>
            <h2 id="skill-heading">Skills</h2>
          </div>
          <small>Manifest · permissions · runtime gates</small>
        </div>
        <div className="settings-intro">
          <p>Manifest 保持只读；这里管理组织级启用状态并审阅内置与受管 CLI Skill 的能力边界。</p>
          <b>
            {skills.filter((item) => item.enabled).length} / {skills.length} 已启用
          </b>
        </div>
        <div className="settings-grid skill-grid">
          {skills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              busy={busyId === skill.id}
              onToggle={toggleSkill}
            />
          ))}
        </div>
      </section>

      <FreeResponseReviewQueue
        items={freeResponseReviews}
        busy={busyId.length > 0}
        onReview={reviewFreeResponse}
      />

      <section className="panel settings-panel" aria-labelledby="run-heading">
        <div className="panel-head settings-panel-head">
          <div>
            <span>04</span>
            <h2 id="run-heading">运行记录</h2>
          </div>
          <small>Query audit · metadata only · embedding 0</small>
        </div>
        <div className="settings-intro">
          <p>只保存问题指纹、候选身份、引用和模型状态，不保存问题、证据或回答正文。</p>
          <b>{queryRuns.length} 条最近记录</b>
        </div>
        {queryRuns.length ? (
          <div className="query-run-list">
            {queryRuns.map((run) => (
              <article className="query-run-row" key={run.id}>
                <header>
                  <div>
                    <span className={`run-mode ${run.answerMode}`}>
                      {RUN_MODE_LABELS[run.answerMode]}
                    </span>
                    <strong>{run.spaceName}</strong>
                  </div>
                  <time dateTime={run.createdAt}>{formatRunTime(run.createdAt)}</time>
                </header>
                <dl>
                  <div>
                    <dt>候选 / 引用</dt>
                    <dd>
                      {run.candidateCount} / {run.citedCount}
                    </dd>
                  </div>
                  <div>
                    <dt>模型</dt>
                    <dd>
                      {run.modelCall
                        ? `${run.modelCall.providerId ?? "未知 Provider"} · ${run.modelCall.status === "succeeded" ? "成功" : "失败"}`
                        : "未调用模型"}
                    </dd>
                  </div>
                  <div>
                    <dt>Embedding</dt>
                    <dd>{run.embeddingCalls}</dd>
                  </div>
                  <div>
                    <dt>总耗时</dt>
                    <dd>{run.durationMs}ms</dd>
                  </div>
                </dl>
                <footer>
                  <span>问题指纹 {run.questionSha256.slice(0, 10)}</span>
                  {run.modelCall?.errorCode ? <span>{run.modelCall.errorCode}</span> : null}
                </footer>
              </article>
            ))}
          </div>
        ) : (
          <p className="settings-empty">还没有知识问答运行记录。完成一次问答后会在这里出现。</p>
        )}
      </section>

      <QueueHealth />
      <OperationsHealth />
      <ModelBudget />
      <AuditExport />
      <StorageUsagePanel />
      <BlobAudit />
      <AccessManagement />
    </div>
  );
}
