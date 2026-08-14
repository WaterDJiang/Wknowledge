"use client";

import { useEffect, useState } from "react";
import type { ApiError } from "@wknowledge/contracts";
import type { ModelInvocationBudgetLimits } from "@wknowledge/core";

type ModelBudgetResponse = {
  windowHours: number;
  limits: ModelInvocationBudgetLimits;
};

export function ModelBudget() {
  const [budget, setBudget] = useState<ModelBudgetResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/settings/model-budget", { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json()) as ModelBudgetResponse | ApiError;
        if (!response.ok) throw new Error((data as ApiError).message ?? "模型额度读取失败");
        return data as ModelBudgetResponse;
      })
      .then(setBudget)
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "模型额度读取失败");
      });
    return () => controller.abort();
  }, []);

  return (
    <section className="panel settings-panel" aria-labelledby="model-budget-heading">
      <div className="panel-head settings-panel-head">
        <div>
          <span>06</span>
          <h2 id="model-budget-heading">模型调用额度</h2>
        </div>
        <small>rolling 24h · invocation count only</small>
      </div>
      <div className="settings-intro">
        <p>额度在实际调用模型前检查；不统计健康检查、检索、资料正文或 token。</p>
        <b>{budget ? `每 ${budget.windowHours} 小时刷新` : "正在读取有效配置"}</b>
      </div>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {budget ? (
        <div className="settings-grid storage-usage-grid">
          <article className="settings-card">
            <h3>组织总额度</h3>
            <p className="settings-description">所有受管模型调用的组织级上限。</p>
            <strong>{budget.limits.organizationDailyLimit} 次</strong>
          </article>
          <article className="settings-card">
            <h3>单个模型服务</h3>
            <p className="settings-description">同一 Provider 耗尽后才尝试其他健康服务。</p>
            <strong>{budget.limits.providerDailyLimit} 次</strong>
          </article>
          <article className="settings-card">
            <h3>单用户额度</h3>
            <p className="settings-description">问答和学习生成按发起用户共同计入。</p>
            <strong>{budget.limits.userDailyLimit} 次</strong>
          </article>
        </div>
      ) : (
        <p className="settings-empty">正在读取模型调用额度…</p>
      )}
    </section>
  );
}
