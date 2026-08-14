import type { LearningProgressReport, LearningReportSnapshot } from "@wknowledge/contracts";

export function LearningProgressReportCard({
  report,
  snapshot,
  viewedSnapshot,
  snapshots,
  creatingSnapshot,
  onCreateSnapshot,
  onSelectSnapshot,
  onShowCurrent
}: {
  report: LearningProgressReport;
  snapshot: LearningReportSnapshot | null;
  viewedSnapshot: LearningReportSnapshot | null;
  snapshots: LearningReportSnapshot[];
  creatingSnapshot: boolean;
  onCreateSnapshot: () => void;
  onSelectSnapshot: (snapshotId: string) => void;
  onShowCurrent: () => void;
}) {
  const exportedSnapshot = viewedSnapshot ?? snapshot;
  const items = [
    [
      "原文完成",
      `${report.units.completed} / ${report.units.total}`,
      `${report.units.completionPercent}%`
    ],
    ["候选练习", String(report.practice.questions), `${report.practice.candidateSets} 组`],
    ["已提交作答", String(report.practice.attempts), "不等于已评分"],
    [
      "客观回顾",
      `${report.practice.objectiveScore} / ${report.practice.objectiveMaximumScore}`,
      `${report.practice.objectiveCorrect} / ${report.practice.objectiveGraded} 答对`
    ],
    ["待人工复核", String(report.practice.pendingReview), "尚未给分"],
    ["可回查作答", String(report.practice.traceableAttempts), "可打开原文依据"],
    [
      "评分证据表现",
      `${report.mastery.gradedKnowledgePoints} / ${report.mastery.totalKnowledgePoints}`,
      report.mastery.averagePercent === null
        ? "暂无评分证据"
        : `当前均分 ${report.mastery.averagePercent}%`
    ]
  ];
  return (
    <section className="learning-section learning-progress-report">
      <header>
        <div>
          <p>06 / 学习进展</p>
          <h3>{viewedSnapshot ? "正在查看冻结报告快照" : "从学习事件与作答证据重建"}</h3>
          <small>
            {viewedSnapshot
              ? "该快照不会随后续学习事件、作答或资料更新改变。"
              : "客观回顾题按确定性规则判定；待人工复核不代表得分、通过或掌握。"}
          </small>
        </div>
        <b>{report.units.completionPercent}%</b>
      </header>
      <div className="learning-report-metrics">
        {items.map(([label, value, note]) => (
          <article key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
      </div>
      <section className="learning-mastery-summary" aria-labelledby="mastery-heading">
        <header>
          <div>
            <b id="mastery-heading">当前评分证据表现</b>
            <small>每个知识点只显示本课程最近一次已评分作答；这不是 AI 推断或长期掌握结论。</small>
          </div>
          <strong>
            {report.mastery.averagePercent === null
              ? "暂无评分证据"
              : `${report.mastery.currentCorrect} 项当前满分 · ${report.mastery.averagePercent}%`}
          </strong>
        </header>
        <ol>
          {report.mastery.items.map((item, index) => (
            <li key={item.knowledgePointId} className={item.status}>
              <div>
                <b>课程知识点 {index + 1}</b>
                <small>
                  {item.status === "graded"
                    ? item.correct
                      ? `最近得分 ${item.score} / ${item.maximumScore} · 当前满分`
                      : `最近得分 ${item.score} / ${item.maximumScore} · 可继续练习`
                    : "暂无评分证据"}
                </small>
              </div>
              <span>可在课程与练习记录回查原文</span>
            </li>
          ))}
        </ol>
      </section>
      <footer className="learning-report-export">
        <div>
          <b>报告导出</b>
          <small>
            {viewedSnapshot
              ? viewedSnapshot.status === "completed"
                ? "这是历史快照对应的 PNG 与 PDF。"
                : "这份历史快照尚未生成完整导出文件。"
              : snapshot?.status === "completed"
                ? "PNG 与 PDF 基于同一份固定指标快照生成。"
                : snapshot?.status === "failed"
                  ? "上一次导出失败；创建新快照后可重新生成。"
                  : snapshot
                    ? "报告正在由 Worker 生成；不会重新计算当前学习数据。"
                    : "生成后会冻结当前指标；后续学习记录不会改写这份报告。"}
          </small>
        </div>
        <div className="learning-report-export-actions">
          {viewedSnapshot ? (
            <button type="button" onClick={onShowCurrent}>
              返回当前进展
            </button>
          ) : (
            <button
              type="button"
              onClick={onCreateSnapshot}
              disabled={
                creatingSnapshot ||
                snapshot?.status === "queued" ||
                snapshot?.status === "rendering"
              }
            >
              {creatingSnapshot || snapshot?.status === "queued" || snapshot?.status === "rendering"
                ? "报告生成中…"
                : "生成报告图片"}
            </button>
          )}
          {exportedSnapshot?.status === "completed" ? (
            <>
              <a
                href={`/api/learning/report/snapshots/${exportedSnapshot.id}/artifacts/png`}
                download
              >
                下载 PNG
              </a>
              <a
                href={`/api/learning/report/snapshots/${exportedSnapshot.id}/artifacts/pdf`}
                download
              >
                下载 PDF
              </a>
            </>
          ) : null}
        </div>
      </footer>
      {snapshots.length ? (
        <section className="learning-report-history" aria-label="历史报告">
          <header>
            <b>历史报告</b>
            <small>选择后查看对应冻结指标，不会替换当前学习数据。</small>
          </header>
          <ol>
            {snapshots.map((item) => (
              <li key={item.id} className={item.id === viewedSnapshot?.id ? "active" : undefined}>
                <button type="button" onClick={() => onSelectSnapshot(item.id)}>
                  <span>{new Date(item.createdAt).toLocaleString("zh-CN")}</span>
                  <small>
                    {item.status === "completed"
                      ? "已生成"
                      : item.status === "failed"
                        ? "生成失败"
                        : "生成中"}
                    {` · ${item.report.units.completionPercent}% 原文完成`}
                  </small>
                </button>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </section>
  );
}
