"use client";

import { useEffect, useState, type FormEvent } from "react";
import { manualFreeResponseReviewItemSchema } from "@wknowledge/contracts";
import type {
  ApiError,
  ManagedModelProviderPreset,
  ManagedModelProvider,
  ManagedQueryRun,
  ManagedSkill,
  ManualFreeResponseReviewItem,
  ModelCapability
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

type ProviderDraft = {
  presetId: string;
  name: string;
  location: "local" | "cloud";
  baseUrl: string;
  model: string;
  capabilities: ModelCapability[];
  apiKey: string;
};

const EMPTY_PROVIDER_DRAFT: ProviderDraft = {
  presetId: "custom",
  name: "",
  location: "local",
  baseUrl: "",
  model: "",
  capabilities: ["chat"],
  apiKey: ""
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
  const [providerPresets, setProviderPresets] = useState<ManagedModelProviderPreset[]>([]);
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [queryRuns, setQueryRuns] = useState<ManagedQueryRun[]>([]);
  const [freeResponseReviews, setFreeResponseReviews] = useState<ManualFreeResponseReviewItem[]>(
    []
  );
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [editingProvider, setEditingProvider] = useState<ManagedModelProvider | null>(null);
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(EMPTY_PROVIDER_DRAFT);
  const selectedPreset = providerPresets.find((preset) => preset.id === providerDraft.presetId);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/settings/model-providers", { signal: controller.signal }),
      fetch("/api/settings/model-provider-presets", { signal: controller.signal }),
      fetch("/api/settings/skills", { signal: controller.signal }),
      fetch("/api/settings/query-runs?limit=20", { signal: controller.signal }),
      fetch("/api/learning/reviews/free-response", { signal: controller.signal })
    ])
      .then(
        async ([providerResponse, presetResponse, skillResponse, runResponse, reviewResponse]) => {
          if (
            !providerResponse.ok ||
            !presetResponse.ok ||
            !skillResponse.ok ||
            !runResponse.ok ||
            !reviewResponse.ok
          )
            throw new Error(
              providerResponse.status === 403 ||
                presetResponse.status === 403 ||
                skillResponse.status === 403 ||
                runResponse.status === 403 ||
                reviewResponse.status === 403
                ? "只有组织管理员可以管理系统设置"
                : "设置读取失败"
            );
          return Promise.all([
            providerResponse.json() as Promise<{ providers: ManagedModelProvider[] }>,
            presetResponse.json() as Promise<{ presets: ManagedModelProviderPreset[] }>,
            skillResponse.json() as Promise<{ skills: ManagedSkill[] }>,
            runResponse.json() as Promise<{ runs: ManagedQueryRun[] }>,
            reviewResponse.json() as Promise<{ items: unknown }>
          ]);
        }
      )
      .then(([providerData, presetData, skillData, runData, reviewData]) => {
        setProviders(providerData.providers);
        setProviderPresets(presetData.presets);
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

  function providerPresetFor(provider: ManagedModelProvider) {
    return providerPresets.find(
      (preset) =>
        preset.location === provider.location &&
        preset.endpoints.some((endpoint) => endpoint.baseUrl === provider.baseUrl) &&
        preset.models.some((model) => model.id === provider.model)
    );
  }

  function editProvider(provider: ManagedModelProvider) {
    const preset = providerPresetFor(provider);
    setEditingProvider(provider);
    setProviderDraft({
      presetId: preset?.id ?? "custom",
      name: provider.name,
      location: provider.location,
      baseUrl: provider.baseUrl,
      model: provider.model,
      capabilities: [...provider.capabilities],
      apiKey: ""
    });
  }

  function cancelProviderEdit() {
    setEditingProvider(null);
    setProviderDraft(EMPTY_PROVIDER_DRAFT);
  }

  function selectProviderPreset(presetId: string) {
    const preset = providerPresets.find((item) => item.id === presetId);
    if (!preset) {
      setProviderDraft((current) => ({ ...current, presetId: "custom" }));
      return;
    }
    const endpoint = preset.endpoints[0];
    const model = preset.models[0];
    if (!endpoint || !model) return;
    setProviderDraft((current) => ({
      ...current,
      presetId: preset.id,
      name: preset.name,
      location: preset.location,
      baseUrl: endpoint.baseUrl,
      model: model.id,
      capabilities: [...preset.capabilities]
    }));
  }

  function updateProviderDraft<Key extends keyof ProviderDraft>(
    key: Key,
    value: ProviderDraft[Key]
  ) {
    setProviderDraft((current) => ({ ...current, [key]: value }));
  }

  function toggleProviderCapability(capability: ModelCapability) {
    setProviderDraft((current) => {
      const capabilities = current.capabilities.includes(capability)
        ? current.capabilities.filter((item) => item !== capability)
        : [...current.capabilities, capability];
      return { ...current, capabilities };
    });
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedPreset && !selectedPreset.allowed) {
      setError("该服务商地址未纳入当前部署网络策略，请让部署管理员加入对应 host 后重试");
      return;
    }
    if (providerDraft.capabilities.length === 0) {
      setError("至少选择一项服务能力");
      return;
    }
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
          name: providerDraft.name,
          capabilities: providerDraft.capabilities,
          location: providerDraft.location,
          baseUrl: providerDraft.baseUrl,
          model: providerDraft.model,
          apiKey: providerDraft.apiKey || undefined,
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
    setProviderDraft(EMPTY_PROVIDER_DRAFT);
    setNotice(wasEditing ? "模型服务已更新，正在测试连接…" : "模型服务已保存，正在测试连接…");
    const testResponse = await fetch(`/api/settings/model-providers/${data.provider.id}/test`, {
      method: "POST"
    });
    if (testResponse.ok) {
      const testData = (await testResponse.json()) as { provider: ManagedModelProvider };
      setProviders((current) =>
        current.map((item) => (item.id === testData.provider.id ? testData.provider : item))
      );
      setNotice(
        testData.provider.health === "healthy"
          ? "模型服务已保存并可用"
          : "模型服务已保存，但连接测试未通过"
      );
    } else {
      setNotice("模型服务已保存，但连接测试失败，请检查 API Key 或服务商状态");
    }
    setBusyId("");
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
        <form className="provider-create" onSubmit={saveProvider}>
          <label>
            服务商
            <select
              value={providerDraft.presetId}
              onChange={(event) => selectProviderPreset(event.target.value)}
            >
              <option value="custom">自定义 OpenAI-compatible</option>
              {providerPresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                  {preset.allowed ? "" : " · 当前部署未允许"}
                </option>
              ))}
            </select>
          </label>
          <label>
            显示名称
            <input
              name="name"
              placeholder="本地 Ollama"
              value={providerDraft.name}
              onChange={(event) => updateProviderDraft("name", event.target.value)}
              required
              minLength={1}
            />
          </label>
          <label>
            部署位置
            <select
              name="location"
              value={providerDraft.location}
              disabled={Boolean(selectedPreset)}
              onChange={(event) =>
                updateProviderDraft("location", event.target.value as ProviderDraft["location"])
              }
            >
              <option value="local">本地</option>
              <option value="cloud">云端</option>
            </select>
          </label>
          <label className="provider-url-field">
            接口地址
            {selectedPreset ? (
              <select
                name="baseUrl"
                value={providerDraft.baseUrl}
                onChange={(event) => updateProviderDraft("baseUrl", event.target.value)}
                required
              >
                {selectedPreset.endpoints.map((endpoint) => (
                  <option key={endpoint.id} value={endpoint.baseUrl}>
                    {endpoint.label} · {endpoint.baseUrl}
                  </option>
                ))}
              </select>
            ) : (
              <input
                name="baseUrl"
                type="url"
                placeholder="http://127.0.0.1:11434/v1"
                value={providerDraft.baseUrl}
                onChange={(event) => updateProviderDraft("baseUrl", event.target.value)}
                required
              />
            )}
          </label>
          <label>
            模型名称
            {selectedPreset ? (
              <select
                name="model"
                value={providerDraft.model}
                onChange={(event) => updateProviderDraft("model", event.target.value)}
                required
              >
                {selectedPreset.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label} · {model.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                name="model"
                placeholder="qwen3"
                value={providerDraft.model}
                onChange={(event) => updateProviderDraft("model", event.target.value)}
                required
              />
            )}
          </label>
          <fieldset className="provider-capabilities">
            <legend>服务能力</legend>
            <label className={selectedPreset ? "is-fixed" : undefined}>
              <input
                name="capabilities"
                type="checkbox"
                value="chat"
                checked={providerDraft.capabilities.includes("chat")}
                disabled={Boolean(selectedPreset)}
                onChange={() => toggleProviderCapability("chat")}
              />
              对话
            </label>
            <label className={selectedPreset ? "is-fixed" : undefined}>
              <input
                name="capabilities"
                type="checkbox"
                value="speech_to_text"
                checked={providerDraft.capabilities.includes("speech_to_text")}
                disabled={Boolean(selectedPreset)}
                onChange={() => toggleProviderCapability("speech_to_text")}
              />
              语音转文字
            </label>
            <label className={selectedPreset ? "is-fixed" : undefined}>
              <input
                name="capabilities"
                type="checkbox"
                value="vision"
                checked={providerDraft.capabilities.includes("vision")}
                disabled={Boolean(selectedPreset)}
                onChange={() => toggleProviderCapability("vision")}
              />
              视觉理解
            </label>
          </fieldset>
          <label>
            API Key（云端必填，本地可选）
            <input
              name="apiKey"
              type="password"
              autoComplete="new-password"
              value={providerDraft.apiKey}
              onChange={(event) => updateProviderDraft("apiKey", event.target.value)}
              placeholder={editingProvider?.hasApiKey ? "留空则保留已保存密钥" : "仅服务端加密保存"}
              required={providerDraft.location === "cloud" && !editingProvider?.hasApiKey}
            />
          </label>
          {selectedPreset && !selectedPreset.allowed ? (
            <p className="provider-policy-hint">
              当前部署未放行 {selectedPreset.name} 的接口地址；请联系部署管理员加入 host。
            </p>
          ) : null}
          <button
            disabled={
              busyId === "create-provider" || Boolean(selectedPreset && !selectedPreset.allowed)
            }
          >
            {busyId === "create-provider"
              ? "保存中…"
              : editingProvider
                ? "保存修改"
                : "添加模型服务"}
          </button>
          {editingProvider ? (
            <button type="button" className="button-quiet" onClick={cancelProviderEdit}>
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
                onEdit={editProvider}
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
