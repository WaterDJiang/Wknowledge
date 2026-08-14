"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  learningCourseSchema,
  learningPlanSchema,
  learningProgressReportSchema,
  type LearningCourse,
  type LearningPlan,
  type LearningProgressReport
} from "@wknowledge/contracts";
import { LearningNavigation } from "./learning-navigation";

function nextStep(plan: LearningPlan | null, course: LearningCourse | null) {
  if (!plan) return { href: "/workspace/learning/content", label: "选择资料并创建计划" };
  if (!course) return { href: "/workspace/learning/content", label: "检查并重新创建计划" };
  return { href: "/workspace/learning/course", label: "继续学习原文" };
}

export default function LearningPage() {
  const [plans, setPlans] = useState<LearningPlan[]>([]);
  const [course, setCourse] = useState<LearningCourse | null>(null);
  const [report, setReport] = useState<LearningProgressReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const activePlan = useMemo(
    () => plans.find(({ status }) => status === "active") ?? null,
    [plans]
  );
  const step = nextStep(activePlan, course);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/learning/plans", { signal: controller.signal }),
      fetch("/api/learning/course/active", { signal: controller.signal }),
      fetch("/api/learning/report/active", { signal: controller.signal })
    ])
      .then(async ([plansResponse, courseResponse, reportResponse]) => {
        const [plansData, courseData, reportData] = await Promise.all([
          plansResponse.json().catch(() => null),
          courseResponse.ok ? courseResponse.json().catch(() => null) : Promise.resolve(null),
          reportResponse.ok ? reportResponse.json().catch(() => null) : Promise.resolve(null)
        ]);
        if (!plansResponse.ok) throw new Error("学习计划暂时无法读取，请稍后重试");
        if (!courseResponse.ok && courseResponse.status !== 404 && courseResponse.status !== 409)
          throw new Error("学习课程暂时无法读取，请稍后重试");
        if (!reportResponse.ok && reportResponse.status !== 404)
          throw new Error("学习进展暂时无法读取，请稍后重试");
        return {
          plans: learningPlanSchema.array().parse(plansData?.plans),
          course: courseResponse.ok ? learningCourseSchema.parse(courseData?.course) : null,
          report: reportResponse.ok ? learningProgressReportSchema.parse(reportData?.report) : null
        };
      })
      .then(({ plans: nextPlans, course: nextCourse, report: nextReport }) => {
        setPlans(nextPlans);
        setCourse(nextCourse);
        setReport(nextReport);
      })
      .catch((value: unknown) => {
        if (value instanceof DOMException && value.name === "AbortError") return;
        setError(value instanceof Error ? value.message : "学习概览读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  if (loading) return <p className="empty">正在读取学习概览…</p>;

  return (
    <section className="learning-workspace">
      <header className="learning-head">
        <div>
          <p className="eyebrow">LEARNING / OVERVIEW</p>
          <h2>{activePlan ? `正在执行：${activePlan.title}` : "从资料开始学习"}</h2>
          <p>学习计划、原文、练习和报告分开管理；每一步都固定指向受权的资料版本。</p>
        </div>
        <span className={activePlan ? "learning-status active" : "learning-status"}>
          {activePlan ? "进行中" : "尚未确认"}
        </span>
      </header>
      <LearningNavigation />
      {error ? <p className="form-error">{error}</p> : null}
      <section className="learning-overview-next">
        <div>
          <p>下一步</p>
          <h3>{step.label}</h3>
          <small>
            {activePlan
              ? "课程、练习和报告只使用这份计划确认时固定的资料版本。"
              : "先从已处理资料中选择内容，系统才会创建可确认的学习计划。"}
          </small>
        </div>
        <Link href={step.href}>{step.label} →</Link>
      </section>
      <div className="learning-overview-grid">
        <Link href="/workspace/learning/content">
          <span>计划</span>
          <strong>{activePlan ? activePlan.title : "选择学习内容"}</strong>
          <small>{plans.length ? `${plans.length} 个计划版本` : "尚未创建计划"}</small>
        </Link>
        <Link href="/workspace/learning/course">
          <span>课程</span>
          <strong>{course ? course.title : "等待计划确认"}</strong>
          <small>{course ? "打开固定版本原文并记录进度" : "确认计划后生成"}</small>
        </Link>
        <Link href="/workspace/learning/practice">
          <span>练习与测评</span>
          <strong>{report ? `${report.practice.attempts} 次作答` : "从已学内容练习"}</strong>
          <small>
            {report ? `${report.practice.pendingReview} 项待人工复核` : "完成原文单元后可开始"}
          </small>
        </Link>
        <Link href="/workspace/learning/reports">
          <span>学习报告</span>
          <strong>{report ? `${report.units.completionPercent}% 原文完成` : "尚无进展报告"}</strong>
          <small>查看可回查指标与历史导出</small>
        </Link>
      </div>
    </section>
  );
}
