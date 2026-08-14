"use client";

import { useEffect, useState } from "react";
import {
  learningProgressReportSchema,
  learningReportSnapshotSchema,
  type LearningProgressReport,
  type LearningReportSnapshot
} from "@wknowledge/contracts";
import { useWorkspace } from "../../workspace-shell";
import { LearningNavigation } from "../learning-navigation";
import { LearningProgressReportCard } from "../progress-report";

export default function LearningReportsPage() {
  const { setNotice } = useWorkspace();
  const [report, setReport] = useState<LearningProgressReport | null>(null);
  const [snapshot, setSnapshot] = useState<LearningReportSnapshot | null>(null);
  const [snapshots, setSnapshots] = useState<LearningReportSnapshot[]>([]);
  const [viewedSnapshot, setViewedSnapshot] = useState<LearningReportSnapshot | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/learning/report/active", { signal: controller.signal }),
      fetch("/api/learning/report/snapshots", { signal: controller.signal })
    ])
      .then(async ([reportResponse, snapshotsResponse]) => {
        const [reportData, snapshotsData] = await Promise.all([
          reportResponse.ok ? reportResponse.json().catch(() => null) : Promise.resolve(null),
          snapshotsResponse.json().catch(() => null)
        ]);
        if (!reportResponse.ok && reportResponse.status !== 404)
          throw new Error("学习进展报告暂时无法读取，请稍后重试");
        if (!snapshotsResponse.ok) throw new Error("历史报告暂时无法读取，请稍后重试");
        const nextSnapshots = learningReportSnapshotSchema.array().parse(snapshotsData?.snapshots);
        return {
          report: reportResponse.ok ? learningProgressReportSchema.parse(reportData?.report) : null,
          snapshots: nextSnapshots
        };
      })
      .then(({ report: nextReport, snapshots: nextSnapshots }) => {
        setReport(nextReport);
        setSnapshots(nextSnapshots);
        if (!nextReport) setViewedSnapshot(nextSnapshots[0] ?? null);
      })
      .catch((value: unknown) => {
        if (value instanceof DOMException && value.name === "AbortError") return;
        setError(value instanceof Error ? value.message : "学习报告读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function createSnapshot() {
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/learning/report/active/snapshots", { method: "POST" });
      const data = (await response.json().catch(() => null)) as {
        snapshot?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "报告快照创建失败");
      const nextSnapshot = learningReportSnapshotSchema.parse(data?.snapshot);
      setSnapshot(nextSnapshot);
      setSnapshots((current) => [
        nextSnapshot,
        ...current.filter(({ id }) => id !== nextSnapshot.id)
      ]);
      if (nextSnapshot.status === "completed") {
        setNotice("报告已就绪，可下载 PNG 或 PDF");
        return;
      }
      setNotice("已冻结当前学习指标，正在生成 PNG 与 PDF…");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 1_000));
        const statusResponse = await fetch(`/api/learning/report/snapshots/${nextSnapshot.id}`);
        const statusData = (await statusResponse.json().catch(() => null)) as {
          snapshot?: unknown;
          message?: string;
        } | null;
        if (!statusResponse.ok) throw new Error(statusData?.message ?? "报告生成状态暂时无法读取");
        const updated = learningReportSnapshotSchema.parse(statusData?.snapshot);
        setSnapshot(updated);
        setSnapshots((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        if (updated.status === "completed") {
          setNotice("报告已生成，可下载 PNG 或 PDF");
          return;
        }
        if (updated.status === "failed") throw new Error(updated.errorMessage ?? "报告生成失败");
      }
      setNotice("报告仍在生成中；可稍后刷新本页后查看下载入口。");
    } catch (value) {
      setError(value instanceof Error ? value.message : "报告快照创建失败");
    } finally {
      setCreating(false);
    }
  }

  async function selectSnapshot(snapshotId: string) {
    setError(null);
    try {
      const response = await fetch(`/api/learning/report/snapshots/${snapshotId}`);
      const data = (await response.json().catch(() => null)) as {
        snapshot?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "历史报告读取失败");
      setViewedSnapshot(learningReportSnapshotSchema.parse(data?.snapshot));
      setNotice("正在查看已冻结的历史报告；当前学习数据没有改变");
    } catch (value) {
      setError(value instanceof Error ? value.message : "历史报告读取失败");
    }
  }

  const displayed = viewedSnapshot?.report ?? report;
  if (loading) return <p className="empty">正在读取学习报告…</p>;
  return (
    <section className="learning-workspace">
      <header className="learning-head">
        <div>
          <p className="eyebrow">LEARNING / REPORTS</p>
          <h2>查看可回查的学习进展</h2>
          <p>指标由学习事件与作答证据重建。导出任务会冻结当前指标，不会随后续学习覆盖。</p>
        </div>
      </header>
      <LearningNavigation />
      {error ? <p className="form-error">{error}</p> : null}
      {displayed ? (
        <LearningProgressReportCard
          report={displayed}
          snapshot={snapshot}
          viewedSnapshot={viewedSnapshot}
          snapshots={snapshots}
          creatingSnapshot={creating}
          onCreateSnapshot={() => void createSnapshot()}
          onSelectSnapshot={(snapshotId) => void selectSnapshot(snapshotId)}
          onShowCurrent={() => {
            setViewedSnapshot(null);
            setNotice("已返回当前学习进展");
          }}
        />
      ) : (
        <section className="learning-section learning-course-unavailable">
          <p>暂无报告</p>
          <h3>确认计划并开始学习后生成</h3>
          <span>报告只投影你自己的课程进度与作答记录，不会用模型文本替代事实指标。</span>
        </section>
      )}
    </section>
  );
}
