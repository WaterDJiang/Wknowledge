"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  learningContentOptionSchema,
  learnerProfileSchema,
  learningPlanSchema,
  planComposeCandidateSchema,
  skillRunSchema,
  type LearningContentOption,
  type LearnerProfile,
  type LearningPlan,
  type PlanComposeCandidate
} from "@wknowledge/contracts";
import { useWorkspace } from "../../workspace-shell";
import { LearnerProfileForm } from "../learner-profile-form";
import { LearningNavigation } from "../learning-navigation";
import { PlanComposeCandidates } from "../plan-compose-candidates";
import { SkillRunStatus } from "../skill-run-status";

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export default function LearningContentPage() {
  const { setNotice } = useWorkspace();
  const [options, setOptions] = useState<LearningContentOption[]>([]);
  const [plans, setPlans] = useState<LearningPlan[]>([]);
  const [skillCandidates, setSkillCandidates] = useState<PlanComposeCandidate[]>([]);
  const [profile, setProfile] = useState<LearnerProfile | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [generatingCandidate, setGeneratingCandidate] = useState(false);
  const [candidateRunId, setCandidateRunId] = useState<string | null>(null);
  const [materializingCandidateId, setMaterializingCandidateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activePlan = useMemo(
    () => plans.find(({ status }) => status === "active") ?? null,
    [plans]
  );

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/learning/content-options", { signal: controller.signal }),
      fetch("/api/learning/plans", { signal: controller.signal }),
      fetch("/api/learners/me", { signal: controller.signal }),
      fetch("/api/learning/plan-candidates", { signal: controller.signal })
    ])
      .then(async ([optionsResponse, plansResponse, profileResponse, candidatesResponse]) => {
        const [optionsData, plansData, profileData, candidatesData] = await Promise.all([
          optionsResponse.json().catch(() => null),
          plansResponse.json().catch(() => null),
          profileResponse.json().catch(() => null),
          candidatesResponse.ok
            ? candidatesResponse.json().catch(() => null)
            : Promise.resolve(null)
        ]);
        if (!optionsResponse.ok || !plansResponse.ok || !profileResponse.ok)
          throw new Error("学习内容暂时无法读取，请稍后重试");
        return {
          options: learningContentOptionSchema.array().parse(optionsData?.options),
          plans: learningPlanSchema.array().parse(plansData?.plans),
          profile: learnerProfileSchema.parse(profileData?.profile),
          candidates: candidatesResponse.ok
            ? planComposeCandidateSchema.array().parse(candidatesData?.candidates)
            : []
        };
      })
      .then(({ options: nextOptions, plans: nextPlans, profile: nextProfile, candidates }) => {
        setOptions(nextOptions);
        setPlans(nextPlans);
        setProfile(nextProfile);
        setSkillCandidates(candidates);
      })
      .catch((value: unknown) => {
        if (value instanceof DOMException && value.name === "AbortError") return;
        setError(value instanceof Error ? value.message : "学习内容读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  function toggleSelection(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    );
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    try {
      const response = await fetch("/api/learners/me", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentLevel: form.get("currentLevel"),
          weeklyMinutes: Number(form.get("weeklyMinutes")),
          preferredPace: form.get("preferredPace"),
          note: String(form.get("note") ?? "")
        })
      });
      const data = (await response.json().catch(() => null)) as {
        profile?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "学习画像保存失败");
      setProfile(learnerProfileSchema.parse(data?.profile));
      setNotice("学习偏好已保存，将用于后续个性化计划候选");
    } catch (value) {
      setError(value instanceof Error ? value.message : "学习画像保存失败");
    }
  }

  async function createDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    const goal = String(form.get("goal") ?? "").trim();
    if (!title || !goal || !selectedIds.length) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/learning/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, goal, resourceVersionIds: selectedIds })
      });
      const data = (await response.json().catch(() => null)) as {
        plan?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "创建学习计划失败");
      const plan = learningPlanSchema.parse(data?.plan);
      setPlans((current) => [plan, ...current]);
      setSelectedIds([]);
      event.currentTarget.reset();
      setNotice("已生成学习计划草稿，请确认后开始学习");
    } catch (value) {
      setError(value instanceof Error ? value.message : "创建学习计划失败");
    } finally {
      setCreating(false);
    }
  }

  async function generateCandidate(formElement: HTMLFormElement) {
    const form = new FormData(formElement);
    const goal = String(form.get("goal") ?? "").trim();
    if (!goal || !selectedIds.length) return;
    setGeneratingCandidate(true);
    setError(null);
    try {
      const response = await fetch("/api/learning/plan-candidates/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, resourceVersionIds: selectedIds })
      });
      const data = (await response.json().catch(() => null)) as {
        run?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "计划候选暂时无法入队");
      setCandidateRunId(skillRunSchema.parse(data?.run).id);
      setNotice("已提交个性化计划候选；处理完成后会出现在下方，确认后才会创建草稿");
      window.setTimeout(() => {
        void fetch("/api/learning/plan-candidates")
          .then(async (next) => {
            if (!next.ok) return;
            const value = await next.json().catch(() => null);
            setSkillCandidates(planComposeCandidateSchema.array().parse(value?.candidates));
          })
          .catch(() => undefined);
      }, 2_000);
    } catch (value) {
      setError(value instanceof Error ? value.message : "计划候选暂时无法入队");
    } finally {
      setGeneratingCandidate(false);
    }
  }

  async function confirm(plan: LearningPlan) {
    setError(null);
    try {
      const response = await fetch(`/api/learning/plans/${plan.id}/confirm`, { method: "POST" });
      const data = (await response.json().catch(() => null)) as {
        plan?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "确认学习计划失败");
      const confirmed = learningPlanSchema.parse(data?.plan);
      setPlans((current) =>
        current.map((value) =>
          value.id === confirmed.id
            ? confirmed
            : value.status === "active"
              ? { ...value, status: "archived" }
              : value
        )
      );
      setNotice("学习计划已确认；课程、原文和练习将固定使用这些资料版本");
    } catch (value) {
      setError(value instanceof Error ? value.message : "确认学习计划失败");
    }
  }

  async function materializeCandidate(candidate: PlanComposeCandidate, goal: string) {
    setMaterializingCandidateId(candidate.id);
    setError(null);
    try {
      const response = await fetch(`/api/learning/plan-candidates/${candidate.id}/materialize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, selectedResourceVersionIds: candidate.resourceVersionIds })
      });
      const data = (await response.json().catch(() => null)) as {
        plan?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "计划候选暂时无法创建草稿");
      const plan = learningPlanSchema.parse(data?.plan);
      setPlans((current) => [plan, ...current]);
      setSkillCandidates((current) =>
        current.map((value) =>
          value.id === candidate.id ? { ...value, materializedLearningPlanId: plan.id } : value
        )
      );
      setNotice("已根据 Skill 建议创建计划草稿；确认后才会开始学习");
    } catch (value) {
      setError(value instanceof Error ? value.message : "计划候选暂时无法创建草稿");
    } finally {
      setMaterializingCandidateId(null);
    }
  }

  if (loading) return <p className="empty">正在读取内容与计划…</p>;

  return (
    <section className="learning-workspace">
      <header className="learning-head">
        <div>
          <p className="eyebrow">LEARNING / CONTENT</p>
          <h2>选择内容并确认学习计划</h2>
          <p>只可选择已处理资料。确认后，课程固定到当前资料版本，不受后续上传覆盖。</p>
        </div>
        <span className={activePlan ? "learning-status active" : "learning-status"}>
          {activePlan ? "已有生效计划" : "尚未确认"}
        </span>
      </header>
      <LearningNavigation />
      {error ? <p className="form-error">{error}</p> : null}
      {profile ? <LearnerProfileForm profile={profile} onSave={saveProfile} /> : null}
      <div className="learning-grid">
        <main>
          <section className="learning-section">
            <header>
              <div>
                <p>01 / 选择内容</p>
                <h3>可学习资料</h3>
              </div>
              <b>{selectedIds.length} 已选择</b>
            </header>
            {options.length ? (
              <div className="learning-content-list">
                {options.map((option) => (
                  <label key={option.resourceVersionId}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(option.resourceVersionId)}
                      onChange={() => toggleSelection(option.resourceVersionId)}
                    />
                    <div>
                      <b>{option.resourceName}</b>
                      <small>
                        {option.spaceName} · V{option.version} · {option.compileProfile} ·{" "}
                        {formatDate(option.createdAt)}
                      </small>
                      <span>{option.originalName}</span>
                    </div>
                  </label>
                ))}
              </div>
            ) : (
              <p className="empty">暂无已处理的资料。请先在“资料库”完成上传和知识整理。</p>
            )}
          </section>
          <form className="learning-draft-form" onSubmit={createDraft}>
            <p>02 / 生成草稿</p>
            <label>
              计划名称
              <input
                name="title"
                required
                maxLength={120}
                placeholder="例如：八月 AI 工作流学习计划"
              />
            </label>
            <label>
              学习目标
              <textarea
                name="goal"
                required
                maxLength={500}
                placeholder="例如：能够用资料中的方法完成一次工作流分析"
              />
            </label>
            <button disabled={creating || !selectedIds.length}>
              {creating ? "正在生成…" : "生成计划草稿"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={generatingCandidate || !selectedIds.length}
              onClick={(event) => void generateCandidate(event.currentTarget.form!)}
            >
              {generatingCandidate ? "正在提交候选…" : "用 Skill 生成个性化候选"}
            </button>
            <small>
              确定性草稿可立即创建；Skill 候选由 Worker 调用受管模型生成，完成后必须由你确认。
            </small>
          </form>
          <SkillRunStatus runId={candidateRunId} onCompleted={() => window.location.reload()} />
          <PlanComposeCandidates
            candidates={skillCandidates}
            materializingId={materializingCandidateId}
            onMaterialize={materializeCandidate}
          />
        </main>
        <aside className="learning-section learning-plan-list">
          <header>
            <div>
              <p>03 / 确认计划</p>
              <h3>计划版本</h3>
            </div>
            <b>{plans.length}</b>
          </header>
          {plans.length ? (
            plans.map((plan) => (
              <article key={plan.id} className={plan.status}>
                <header>
                  <span>
                    {plan.status === "active"
                      ? "已生效"
                      : plan.status === "draft"
                        ? "草稿"
                        : "历史"}
                  </span>
                  <small>V{plan.version}</small>
                </header>
                <h4>{plan.title}</h4>
                <p>{plan.plan.goal}</p>
                <small>
                  {plan.plan.selections.length} 份固定版本资料 · {plan.plan.units.length} 个学习单元
                </small>
                {plan.status === "draft" ? (
                  <button onClick={() => void confirm(plan)}>确认并开始学习</button>
                ) : null}
              </article>
            ))
          ) : (
            <p className="empty">生成草稿后，会在此处等待你的确认。</p>
          )}
        </aside>
      </div>
    </section>
  );
}
