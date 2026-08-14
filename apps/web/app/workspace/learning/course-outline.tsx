import Link from "next/link";
import type { LearningCourse, LearningUnitProgress } from "@wknowledge/contracts";

export function LearningCourseOutline({
  course,
  progress,
  onRecord
}: {
  course: LearningCourse;
  progress: LearningUnitProgress[];
  onRecord: (unit: LearningUnitProgress, verb: "opened" | "completed") => void;
}) {
  const progressByPlanUnitId = new Map(progress.map((unit) => [unit.id, unit]));
  const courseUnits = course.modules.flatMap((module) => module.units);
  const completed = courseUnits.filter(
    (unit) => progressByPlanUnitId.get(unit.planUnitId)?.completedAt
  );
  return (
    <section className="learning-section learning-course-outline">
      <header>
        <div>
          <p>04 / 课程结构</p>
          <h3>{course.title}</h3>
          <small>{course.goal}</small>
        </div>
        <b>
          {completed.length}/{courseUnits.length} 已完成
        </b>
      </header>
      {course.modules.map((module) => (
        <article className="learning-course-module" key={module.id}>
          <header>
            <span>模块 {String(module.ordinal).padStart(2, "0")}</span>
            <p>{module.title}</p>
          </header>
          <small>{module.objective}</small>
          <div className="learning-unit-list">
            {module.units.map((courseUnit) => {
              const unit = progressByPlanUnitId.get(courseUnit.planUnitId);
              if (!unit) return null;
              return (
                <article key={courseUnit.id} className={unit.completedAt ? "completed" : ""}>
                  <span>{String(courseUnit.ordinal).padStart(2, "0")}</span>
                  <div>
                    <h4>{courseUnit.title}</h4>
                    <p>{courseUnit.objective}</p>
                    <small>
                      {unit.events ? `已记录 ${unit.events} 次学习事件` : courseUnit.completionRule}
                    </small>
                    <details className="learning-knowledge-points">
                      <summary>学习重点 · {courseUnit.knowledgePoints.length}</summary>
                      {courseUnit.knowledgePoints.map((point) => (
                        <p key={point.id}>{point.statement}</p>
                      ))}
                    </details>
                  </div>
                  <div className="learning-unit-actions">
                    <Link
                      href={`/workspace/source?ref=${encodeURIComponent(unit.sourceRef)}&learningUnit=${encodeURIComponent(unit.id)}`}
                      target="_blank"
                      onClick={() => onRecord(unit, "opened")}
                    >
                      打开原文 ↗
                    </Link>
                    <button
                      disabled={Boolean(unit.completedAt)}
                      onClick={() => onRecord(unit, "completed")}
                    >
                      {unit.completedAt ? "已完成" : "标记完成"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </article>
      ))}
    </section>
  );
}
