"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  learningCourseSchema,
  learningUnitProgressSchema,
  practiceAttemptSchema,
  practiceGenerateCandidateSchema,
  skillRunSchema,
  practiceMistakeReviewItemSchema,
  practiceSetSchema,
  type LearningCourse,
  type LearningUnitProgress,
  type PracticeMistakeReviewItem,
  type PracticeGenerateCandidate,
  type PracticeSet
} from "@wknowledge/contracts";
import { useWorkspace } from "../../workspace-shell";
import { LearningNavigation } from "../learning-navigation";
import { PracticeCandidates } from "../practice-candidates";
import { PracticeMistakeReview } from "../mistake-review";
import { SkillRunStatus } from "../skill-run-status";

export default function LearningPracticePage() {
  const { setNotice } = useWorkspace();
  const router = useRouter();
  const [course, setCourse] = useState<LearningCourse | null>(null);
  const [units, setUnits] = useState<LearningUnitProgress[]>([]);
  const [candidates, setCandidates] = useState<PracticeSet[]>([]);
  const [skillCandidates, setSkillCandidates] = useState<PracticeGenerateCandidate[]>([]);
  const [mistakes, setMistakes] = useState<PracticeMistakeReviewItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [confirmingAssessmentCandidateId, setConfirmingAssessmentCandidateId] = useState<
    string | null
  >(null);
  const [candidateRunId, setCandidateRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/learning/course/active", { signal: controller.signal }),
      fetch("/api/learning/active", { signal: controller.signal }),
      fetch("/api/learning/practice", { signal: controller.signal }),
      fetch("/api/learning/review/mistakes", { signal: controller.signal })
    ])
      .then(async ([courseResponse, activeResponse, practiceResponse, mistakesResponse]) => {
        const [courseData, activeData, practiceData, mistakesData] = await Promise.all([
          courseResponse.ok ? courseResponse.json().catch(() => null) : Promise.resolve(null),
          activeResponse.ok ? activeResponse.json().catch(() => null) : Promise.resolve(null),
          practiceResponse.ok ? practiceResponse.json().catch(() => null) : Promise.resolve(null),
          mistakesResponse.ok ? mistakesResponse.json().catch(() => null) : Promise.resolve(null)
        ]);
        if (!courseResponse.ok && courseResponse.status !== 404 && courseResponse.status !== 409)
          throw new Error("学习课程暂时无法读取，请稍后重试");
        if (!activeResponse.ok && activeResponse.status !== 404)
          throw new Error("学习进度暂时无法读取，请稍后重试");
        if (!practiceResponse.ok && practiceResponse.status !== 409)
          throw new Error("练习候选暂时无法读取，请稍后重试");
        if (!mistakesResponse.ok && mistakesResponse.status !== 404)
          throw new Error("错题回顾暂时无法读取，请稍后重试");
        return {
          course: courseResponse.ok ? learningCourseSchema.parse(courseData?.course) : null,
          units: activeResponse.ok
            ? learningUnitProgressSchema.array().parse(activeData?.units)
            : [],
          candidates: practiceResponse.ok
            ? practiceSetSchema.array().parse(practiceData?.candidates)
            : [],
          mistakes: mistakesResponse.ok
            ? practiceMistakeReviewItemSchema.array().parse(mistakesData?.items)
            : []
        };
      })
      .then(
        ({
          course: nextCourse,
          units: nextUnits,
          candidates: nextCandidates,
          mistakes: nextMistakes
        }) => {
          setCourse(nextCourse);
          setUnits(nextUnits);
          setCandidates(nextCandidates);
          setMistakes(nextMistakes);
        }
      )
      .catch((value: unknown) => {
        if (value instanceof DOMException && value.name === "AbortError") return;
        setError(value instanceof Error ? value.message : "练习数据读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    void fetch("/api/learning/practice-candidates")
      .then(async (response) => {
        if (!response.ok) return [];
        return practiceGenerateCandidateSchema.array().parse((await response.json()).candidates);
      })
      .then(setSkillCandidates)
      .catch(() => undefined);
  }, []);

  async function createPractice(courseUnitIds: string[], difficulty: PracticeSet["difficulty"]) {
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/learning/practice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courseUnitIds, difficulty })
      });
      const data = (await response.json().catch(() => null)) as {
        candidate?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "练习候选生成失败");
      const candidate = practiceSetSchema.parse(data?.candidate);
      setCandidates((current) => [candidate, ...current]);
      setNotice("已生成有来源的练习候选；基础回顾题可确定性判定，其他题等待人工复核");
    } catch (value) {
      setError(value instanceof Error ? value.message : "练习候选生成失败");
    } finally {
      setCreating(false);
    }
  }

  async function generatePractice(courseUnitIds: string[], difficulty: PracticeSet["difficulty"]) {
    setGenerating(true);
    setError(null);
    try {
      const response = await fetch("/api/learning/practice-candidates/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courseUnitIds, difficulty })
      });
      const data = (await response.json().catch(() => null)) as {
        run?: unknown;
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "练习候选暂时无法入队");
      setCandidateRunId(skillRunSchema.parse(data?.run).id);
      setNotice("已提交 Skill 练习候选；完成后请刷新页面查看并确认候选题目");
    } catch (value) {
      setError(value instanceof Error ? value.message : "练习候选暂时无法入队");
    } finally {
      setGenerating(false);
    }
  }

  async function materializeSkillCandidate(candidate: PracticeGenerateCandidate) {
    const response = await fetch(`/api/learning/practice-candidates/${candidate.id}/materialize`, {
      method: "POST"
    });
    const data = (await response.json().catch(() => null)) as {
      candidate?: unknown;
      message?: string;
    } | null;
    if (!response.ok) throw new Error(data?.message ?? "练习候选暂时无法确认");
    const practiceSet = practiceSetSchema.parse(data?.candidate);
    setCandidates((current) => [practiceSet, ...current]);
    setSkillCandidates((current) =>
      current.map((item) =>
        item.id === candidate.id ? { ...item, materializedPracticeSetId: practiceSet.id } : item
      )
    );
    setNotice("已确认 Skill 练习候选；现在可以开始作答或创建正式测评");
  }

  async function createAssessmentFromSkillCandidate(candidate: PracticeGenerateCandidate) {
    setConfirmingAssessmentCandidateId(candidate.id);
    setError(null);
    try {
      const response = await fetch(
        `/api/learning/practice-candidates/${candidate.id}/materialize-assessment`,
        { method: "POST" }
      );
      const data = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(data?.message ?? "正式测评创建失败");
      setNotice("已确认 Skill 候选并冻结正式测评题卷；现在可开始单次作答");
      router.push("/workspace/learning/assessments");
    } catch (value) {
      setError(value instanceof Error ? value.message : "正式测评创建失败");
    } finally {
      setConfirmingAssessmentCandidateId(null);
    }
  }

  async function submitPracticeAttempt(questionId: string, response: string) {
    const result = await fetch(`/api/learning/practice/${questionId}/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response })
    });
    const data = (await result.json().catch(() => null)) as {
      attempt?: unknown;
      message?: string;
    } | null;
    if (!result.ok) throw new Error(data?.message ?? "练习答案保存失败");
    const attempt = practiceAttemptSchema.parse(data?.attempt);
    setCandidates((current) =>
      current.map((candidate) => ({
        ...candidate,
        questions: candidate.questions.map((question) =>
          question.id === attempt.practiceQuestionId
            ? { ...question, attempts: [attempt, ...question.attempts] }
            : question
        )
      }))
    );
    const mistakesResponse = await fetch("/api/learning/review/mistakes");
    const mistakesData = (await mistakesResponse.json().catch(() => null)) as {
      items?: unknown;
    } | null;
    if (mistakesResponse.ok)
      setMistakes(practiceMistakeReviewItemSchema.array().parse(mistakesData?.items));
    setNotice(
      attempt.grade
        ? `作答已判定：${attempt.grade.correct ? "回答正确" : "建议回到原文再复习"}（${attempt.grade.score}/${attempt.grade.maximumScore}）`
        : "作答已保存，当前等待人工复核；系统不会自动给分"
    );
  }

  async function createAssessment(practiceSetId: string) {
    const response = await fetch("/api/learning/assessments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ practiceSetId })
    });
    const data = (await response.json().catch(() => null)) as { message?: string } | null;
    if (!response.ok) throw new Error(data?.message ?? "正式测评创建失败");
    setNotice("已冻结正式测评题卷；现在可开始单次作答");
    router.push("/workspace/learning/assessments");
  }

  if (loading) return <p className="empty">正在读取练习与测评…</p>;
  return (
    <section className="learning-workspace">
      <header className="learning-head">
        <div>
          <p className="eyebrow">LEARNING / PRACTICE</p>
          <h2>从已完成原文开始练习</h2>
          <p>每道题都固定知识点、资料版本和来源；正式测评与日常练习保持独立。</p>
        </div>
      </header>
      <LearningNavigation />
      {error ? <p className="form-error">{error}</p> : null}
      {course ? (
        <>
          <PracticeCandidates
            course={course}
            progress={units}
            candidates={candidates}
            creating={creating}
            generating={generating}
            onCreate={(unitIds, difficulty) => void createPractice(unitIds, difficulty)}
            onGenerate={(unitIds, difficulty) => void generatePractice(unitIds, difficulty)}
            onCreateAssessment={createAssessment}
            onSubmitAttempt={submitPracticeAttempt}
          />
          <SkillRunStatus runId={candidateRunId} onCompleted={() => window.location.reload()} />
          {skillCandidates.length ? (
            <section className="learning-section">
              <header>
                <div>
                  <p>SKILL / PRACTICE</p>
                  <h3>待确认的针对性练习</h3>
                </div>
              </header>
              {skillCandidates.map((candidate) => (
                <article key={candidate.id}>
                  <p>
                    {candidate.questions.length} 道有来源题目 · {candidate.difficulty}
                  </p>
                  {candidate.questions.map((question) => (
                    <p key={`${candidate.id}:${question.knowledgePointId}`}>
                      {question.prompt} ·{" "}
                      <a
                        href={`/workspace/source?ref=${encodeURIComponent(question.sourceRef)}`}
                        target="_blank"
                      >
                        原文依据 ↗
                      </a>
                    </p>
                  ))}
                  {candidate.materializedPracticeSetId ? (
                    <button
                      onClick={() => void createAssessmentFromSkillCandidate(candidate)}
                      disabled={confirmingAssessmentCandidateId === candidate.id}
                    >
                      {confirmingAssessmentCandidateId === candidate.id
                        ? "正在打开测评…"
                        : "确认正式测评 →"}
                    </button>
                  ) : (
                    <div className="practice-skill-candidate-actions">
                      <button onClick={() => void materializeSkillCandidate(candidate)}>
                        确认日常练习
                      </button>
                      <button
                        className="secondary"
                        onClick={() => void createAssessmentFromSkillCandidate(candidate)}
                        disabled={confirmingAssessmentCandidateId === candidate.id}
                      >
                        {confirmingAssessmentCandidateId === candidate.id
                          ? "正在创建测评…"
                          : "确认并创建正式测评 →"}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </section>
          ) : null}
          <PracticeMistakeReview items={mistakes} />
        </>
      ) : (
        <section className="learning-section learning-course-unavailable">
          <p>练习尚未就绪</p>
          <h3>请先确认计划并完成至少一个原文单元</h3>
          <span>练习范围只会使用当前计划中已完成且可回查的资料版本。</span>
        </section>
      )}
    </section>
  );
}
