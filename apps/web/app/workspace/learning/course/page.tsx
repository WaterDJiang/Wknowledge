"use client";

import { useEffect, useState } from "react";
import {
  learningCourseSchema,
  learningUnitProgressSchema,
  type LearningCourse,
  type LearningUnitProgress
} from "@wknowledge/contracts";
import { useWorkspace } from "../../workspace-shell";
import { LearningCourseOutline } from "../course-outline";
import { LearningNavigation } from "../learning-navigation";

export default function LearningCoursePage() {
  const { setNotice } = useWorkspace();
  const [course, setCourse] = useState<LearningCourse | null>(null);
  const [units, setUnits] = useState<LearningUnitProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/learning/course/active", { signal: controller.signal }),
      fetch("/api/learning/active", { signal: controller.signal })
    ])
      .then(async ([courseResponse, activeResponse]) => {
        const [courseData, activeData] = await Promise.all([
          courseResponse.ok ? courseResponse.json().catch(() => null) : Promise.resolve(null),
          activeResponse.ok ? activeResponse.json().catch(() => null) : Promise.resolve(null)
        ]);
        if (!courseResponse.ok && courseResponse.status !== 404 && courseResponse.status !== 409)
          throw new Error("学习课程暂时无法读取，请稍后重试");
        if (!activeResponse.ok && activeResponse.status !== 404)
          throw new Error("学习进度暂时无法读取，请稍后重试");
        return {
          course: courseResponse.ok ? learningCourseSchema.parse(courseData?.course) : null,
          units: activeResponse.ok
            ? learningUnitProgressSchema.array().parse(activeData?.units)
            : []
        };
      })
      .then(({ course: nextCourse, units: nextUnits }) => {
        setCourse(nextCourse);
        setUnits(nextUnits);
      })
      .catch((value: unknown) => {
        if (value instanceof DOMException && value.name === "AbortError") return;
        setError(value instanceof Error ? value.message : "学习课程读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function record(unit: LearningUnitProgress, verb: "opened" | "completed") {
    setError(null);
    try {
      const response = await fetch("/api/learning/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unitId: unit.id, verb, sourceRef: unit.sourceRef })
      });
      const data = (await response.json().catch(() => null)) as {
        units?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "学习记录保存失败");
      setUnits(learningUnitProgressSchema.array().parse(data?.units));
      setNotice(verb === "completed" ? "已记录完成，可在练习页选择已学内容" : "已记录原文打开");
    } catch (value) {
      setError(value instanceof Error ? value.message : "学习记录保存失败");
    }
  }

  if (loading) return <p className="empty">正在读取课程原文…</p>;

  return (
    <section className="learning-workspace">
      <header className="learning-head">
        <div>
          <p className="eyebrow">LEARNING / COURSE</p>
          <h2>按固定版本阅读原文</h2>
          <p>每个单元都回到受权资料的指定位置；打开与完成会追加学习事件，不会改写原始资料。</p>
        </div>
      </header>
      <LearningNavigation />
      {error ? <p className="form-error">{error}</p> : null}
      {course ? (
        <LearningCourseOutline
          course={course}
          progress={units}
          onRecord={(unit, verb) => void record(unit, verb)}
        />
      ) : (
        <section className="learning-section learning-course-unavailable">
          <p>课程尚未就绪</p>
          <h3>请先确认一份学习计划</h3>
          <span>确认计划后，系统才会使用该计划固定的资料版本创建可回查课程。</span>
        </section>
      )}
    </section>
  );
}
