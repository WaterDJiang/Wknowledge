import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import type {
  LearningCourse,
  LearningUnitProgress,
  PracticeQuestion,
  PracticeSet
} from "@wknowledge/contracts";
import { selectedPracticeUnitIds, togglePracticeUnitExclusion } from "./practice-selection";

const DIFFICULTY_LABELS = {
  easy: "基础回顾",
  standard: "标准练习",
  challenge: "进阶思考"
} as const;

export function PracticeCandidates({
  course,
  progress,
  candidates,
  creating,
  generating,
  onCreate,
  onGenerate,
  onCreateAssessment,
  onSubmitAttempt
}: {
  course: LearningCourse;
  progress: LearningUnitProgress[];
  candidates: PracticeSet[];
  creating: boolean;
  generating: boolean;
  onCreate: (courseUnitIds: string[], difficulty: PracticeSet["difficulty"]) => void;
  onGenerate: (courseUnitIds: string[], difficulty: PracticeSet["difficulty"]) => void;
  onCreateAssessment: (practiceSetId: string) => Promise<void>;
  onSubmitAttempt: (questionId: string, response: string) => Promise<void>;
}) {
  const progressByPlanUnitId = useMemo(
    () => new Map(progress.map((unit) => [unit.id, unit])),
    [progress]
  );
  const completedUnits = useMemo(
    () =>
      course.modules
        .flatMap((module) => module.units)
        .filter((unit) => progressByPlanUnitId.get(unit.planUnitId)?.completedAt),
    [course, progressByPlanUnitId]
  );
  const completedUnitIds = useMemo(() => completedUnits.map(({ id }) => id), [completedUnits]);
  const [excludedUnitIds, setExcludedUnitIds] = useState<string[]>([]);
  const selectedUnitIds = selectedPracticeUnitIds(completedUnitIds, excludedUnitIds);

  function toggleUnit(unitId: string) {
    setExcludedUnitIds((current) => togglePracticeUnitExclusion(current, unitId));
  }

  return (
    <section id="practice-candidates" className="learning-section practice-candidates">
      <header>
        <div>
          <p>05 / 针对性练习</p>
          <h3>从已完成的原文开始复盘</h3>
          <small>基础回顾题会确定性判定；标准与进阶题仍需人工复核。</small>
        </div>
        <b>
          {selectedUnitIds.length}/{completedUnits.length} 个已选择
        </b>
      </header>
      {completedUnits.length ? (
        <>
          <fieldset className="practice-unit-selector">
            <legend>选择本次练习内容</legend>
            {completedUnits.map((unit) => (
              <label key={unit.id}>
                <input
                  type="checkbox"
                  checked={selectedUnitIds.includes(unit.id)}
                  onChange={() => toggleUnit(unit.id)}
                  disabled={creating}
                />
                <span>{unit.title}</span>
              </label>
            ))}
          </fieldset>
          <div className="practice-actions">
            {(Object.keys(DIFFICULTY_LABELS) as PracticeSet["difficulty"][]).map((difficulty) => (
              <Fragment key={difficulty}>
                <button
                  key={difficulty}
                  disabled={creating || !selectedUnitIds.length}
                  onClick={() => onCreate(selectedUnitIds, difficulty)}
                >
                  {creating ? "正在生成…" : `生成${DIFFICULTY_LABELS[difficulty]}`}
                </button>
                <button
                  key={`skill-${difficulty}`}
                  className="secondary"
                  disabled={generating || !selectedUnitIds.length}
                  onClick={() => onGenerate(selectedUnitIds, difficulty)}
                >
                  {generating ? "正在提交…" : `Skill ${DIFFICULTY_LABELS[difficulty]}`}
                </button>
              </Fragment>
            ))}
          </div>
        </>
      ) : (
        <p className="empty">完成至少一个原文学习单元后，可以在这里生成有依据的练习候选。</p>
      )}
      {candidates.length ? (
        <div className="practice-candidate-list">
          {candidates.map((candidate) => (
            <article key={candidate.id}>
              <header>
                <div>
                  <span>候选练习</span>
                  <small>{DIFFICULTY_LABELS[candidate.difficulty]}</small>
                </div>
                <button
                  className="assessment-confirm"
                  onClick={() => void onCreateAssessment(candidate.id)}
                >
                  确认正式测评 →
                </button>
              </header>
              <p className="assessment-explainer">
                确认后将冻结题目、原文依据和版本；正式测评每题仅可提交一次。
              </p>
              {candidate.questions.map((question, index) => (
                <PracticeQuestionCard
                  key={question.id}
                  question={question}
                  ordinal={index + 1}
                  onSubmitAttempt={onSubmitAttempt}
                />
              ))}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function PracticeQuestionCard({
  question,
  ordinal,
  onSubmitAttempt
}: {
  question: PracticeQuestion;
  ordinal: number;
  onSubmitAttempt: (questionId: string, response: string) => Promise<void>;
}) {
  const [response, setResponse] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = response.trim();
    if (!value) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmitAttempt(question.id, value);
      setResponse("");
    } catch (value) {
      setError(value instanceof Error ? value.message : "练习答案保存失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <p>
        {String(ordinal).padStart(2, "0")} · {question.prompt}
      </p>
      <small>{question.rubric.note}</small>
      <Link
        href={`/workspace/source?ref=${encodeURIComponent(question.sourceRef)}`}
        target="_blank"
      >
        查看原文依据 ↗
      </Link>
      <form className="practice-attempt-form" onSubmit={(event) => void submit(event)}>
        <label>
          写下你的答案
          <textarea
            value={response}
            onChange={(event) => setResponse(event.target.value)}
            maxLength={4000}
            required
            placeholder={
              question.answerType === "exact_response"
                ? "请写出原文中的学习重点"
                : "请结合原文依据作答"
            }
          />
        </label>
        <button disabled={submitting || !response.trim()}>
          {submitting
            ? "正在保存…"
            : question.answerType === "exact_response"
              ? "提交并判定"
              : "提交作答"}
        </button>
        {error ? <small className="form-error">{error}</small> : null}
      </form>
      {question.attempts.length ? (
        <div className="practice-attempt-list">
          {question.attempts.map((attempt) => (
            <article key={attempt.id}>
              <header>
                <span>{attempt.status === "graded" ? "已判定" : "已保存"}</span>
                <small>
                  {attempt.grade
                    ? `${attempt.grade.correct ? "回答正确" : "需要回顾"} · ${attempt.grade.score}/${attempt.grade.maximumScore}`
                    : "待人工复核"}{" "}
                  · V{attempt.questionVersion}
                </small>
              </header>
              {attempt.grade?.rationale ? <small>评分依据：{attempt.grade.rationale}</small> : null}
              <p>{attempt.response}</p>
              <small>{new Date(attempt.submittedAt).toLocaleString("zh-CN")}</small>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
