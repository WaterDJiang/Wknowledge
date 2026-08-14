"use client";

import { useEffect, useState } from "react";
import { skillRunSchema, type SkillRun } from "@wknowledge/contracts";

const LABELS: Record<SkillRun["status"], string> = {
  queued: "已排队，等待 Worker 处理",
  running: "正在生成候选…",
  completed: "候选已生成，请在下方确认",
  failed: "生成失败，请检查模型设置或稍后重试",
  stopped: "生成已停止"
};

export function SkillRunStatus({
  runId,
  onCompleted
}: {
  runId: string | null;
  onCompleted?: () => void;
}) {
  const [run, setRun] = useState<SkillRun | null>(null);
  useEffect(() => {
    if (!runId) return;
    let active = true;
    const read = async () => {
      const response = await fetch(`/api/skill-runs/${runId}`);
      if (!response.ok || !active) return;
      const data = await response.json().catch(() => null);
      if (!active) return;
      const next = skillRunSchema.parse(data?.run);
      setRun(next);
      if (next.status === "completed") onCompleted?.();
    };
    void read();
    const timer = window.setInterval(() => void read(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [runId, onCompleted]);
  if (!runId) return null;
  return (
    <p className={`learning-status ${run?.status ?? ""}`}>
      {run ? LABELS[run.status] : "正在读取运行状态…"}
    </p>
  );
}
