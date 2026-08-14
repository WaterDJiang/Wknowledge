"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import type { PlanComposeCandidate } from "@wknowledge/contracts";

export function PlanComposeCandidates({
  candidates,
  materializingId,
  onMaterialize
}: {
  candidates: PlanComposeCandidate[];
  materializingId: string | null;
  onMaterialize: (candidate: PlanComposeCandidate, goal: string) => Promise<void>;
}) {
  const [goals, setGoals] = useState<Record<string, string>>({});
  const available = candidates.filter(
    ({ materializedLearningPlanId }) => !materializedLearningPlanId
  );

  function submit(candidate: PlanComposeCandidate, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const goal = (goals[candidate.id] ?? "").trim();
    if (!goal) return;
    void onMaterialize(candidate, goal);
  }

  if (!candidates.length) return null;
  return (
    <section className="learning-section plan-compose-candidate-list">
      <header>
        <div>
          <p>02 / Skill 候选</p>
          <h3>查看可确认的计划建议</h3>
        </div>
        <b>{available.length} 待处理</b>
      </header>
      <p className="plan-compose-candidate-intro">
        每条建议都固定来自一次已完成的 Skill 运行。确认后才会创建新的计划草稿。
      </p>
      <div className="plan-compose-candidate-grid">
        {candidates.map((candidate) => {
          const isMaterialized = Boolean(candidate.materializedLearningPlanId);
          const busy = materializingId === candidate.id;
          return (
            <article key={candidate.id} className={isMaterialized ? "materialized" : undefined}>
              <header>
                <div>
                  <span>{isMaterialized ? "已创建草稿" : "待确认"}</span>
                  <h4>{candidate.title}</h4>
                </div>
                <small>{candidate.resourceVersionIds.length} 份固定资料</small>
              </header>
              <ol>
                {candidate.units.map((unit) => (
                  <li key={`${candidate.id}:${unit.resourceVersionId}:${unit.title}`}>
                    <b>{unit.title}</b>
                    <span>{unit.objective}</span>
                    <Link
                      href={`/workspace/source?ref=${encodeURIComponent(unit.sourceRef)}`}
                      target="_blank"
                    >
                      查看原文依据 ↗
                    </Link>
                  </li>
                ))}
              </ol>
              {isMaterialized ? (
                <p className="candidate-materialized-note">该候选已生成草稿，不能重复使用。</p>
              ) : (
                <form onSubmit={(event) => submit(candidate, event)}>
                  <label>
                    本次学习目标
                    <textarea
                      value={goals[candidate.id] ?? ""}
                      maxLength={500}
                      required
                      disabled={busy}
                      placeholder="说明希望通过这些资料达成什么结果"
                      onChange={(event) =>
                        setGoals((current) => ({ ...current, [candidate.id]: event.target.value }))
                      }
                    />
                  </label>
                  <small>将固定使用候选覆盖的全部资料版本，不能在此处修改内容或来源。</small>
                  <button disabled={busy || !(goals[candidate.id] ?? "").trim()}>
                    {busy ? "正在创建草稿…" : "按此建议创建草稿"}
                  </button>
                </form>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
