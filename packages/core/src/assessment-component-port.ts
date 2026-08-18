import type { SourceLocator } from "@wknowledge/contracts";

/**
 * Assessment component port (M6-14, upgrade spec §4.2).
 *
 * Skills can only produce candidates through `composeCandidate`; publishing,
 * submitting, deterministic grading and review requests are domain-controlled
 * operations. Formal assessments, attempts and grades are snapshots that never
 * depend on a Pi session. The in-memory implementation below is the semantic
 * reference for the database-backed adapter.
 */

export type AssessmentItemKind = "exact_response" | "free_response";

export interface AssessmentCandidateItem {
  id: string;
  kind: AssessmentItemKind;
  prompt: string;
  knowledgePointId: string;
  resourceVersionId: string;
  locator: SourceLocator;
  /** Required for free_response items; excluded from deterministic grading. */
  scale?: { min: number; max: number };
  /** Correct answer, required for exact_response items at candidate time. */
  expectedAnswer?: string;
}

export interface AssessmentCandidate {
  id: string;
  courseId: string | null;
  sourceRunId: string | null;
  items: readonly AssessmentCandidateItem[];
  createdAt: string;
}

export interface AssessmentSnapshot {
  id: string;
  candidateId: string;
  version: number;
  items: readonly AssessmentCandidateItem[];
  publishedAt: string;
}

export interface AttemptSnapshot {
  id: string;
  assessmentId: string;
  learnerId: string;
  answers: ReadonlyArray<{ itemId: string; value: string }>;
  submittedAt: string;
}

export interface GradeSnapshot {
  id: string;
  attemptId: string;
  perItem: ReadonlyArray<{
    itemId: string;
    kind: AssessmentItemKind;
    correct: boolean | null;
    gradedBy: "deterministic" | "pending-review";
  }>;
  gradedAt: string;
}

export interface ReviewTask {
  id: string;
  attemptId: string;
  itemId: string;
  requestedAt: string;
}

export interface AssessmentComponent {
  composeCandidate(input: {
    courseId?: string;
    sourceRunId?: string;
    items: readonly AssessmentCandidateItem[];
  }): Promise<AssessmentCandidate>;
  publish(input: { candidateId: string; publishedBy: string }): Promise<AssessmentSnapshot>;
  submit(input: {
    assessmentId: string;
    learnerId: string;
    answers: ReadonlyArray<{ itemId: string; value: string }>;
  }): Promise<AttemptSnapshot>;
  gradeObjective(input: { attemptId: string }): Promise<GradeSnapshot>;
  requestReview(input: { attemptId: string; itemId: string }): Promise<ReviewTask>;
}

function assessmentError(code: string): never {
  throw new Error(code);
}

let sequence = 0;
function nextId(prefix: string, clock: () => number): string {
  sequence += 1;
  return `${prefix}-${sequence.toString().padStart(8, "0")}-${clock()}`;
}

function validateCandidateItems(items: readonly AssessmentCandidateItem[]): void {
  if (!Array.isArray(items) || items.length === 0) assessmentError("ASSESSMENT_CANDIDATE_EMPTY");
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item.id !== "string" || item.id.length === 0 || seen.has(item.id)) {
      assessmentError("ASSESSMENT_ITEM_ID_INVALID");
    }
    seen.add(item.id);
    if (item.prompt.trim().length === 0) assessmentError("ASSESSMENT_ITEM_PROMPT_INVALID");
    if (item.knowledgePointId.length === 0 || item.resourceVersionId.length === 0) {
      assessmentError("ASSESSMENT_ITEM_SOURCE_INVALID");
    }
    if (item.kind === "exact_response" && typeof item.expectedAnswer !== "string") {
      assessmentError("ASSESSMENT_ANSWER_KEY_MISSING");
    }
    if (item.kind === "free_response") {
      if (
        typeof item.scale !== "object" ||
        !Number.isInteger(item.scale.min) ||
        !Number.isInteger(item.scale.max) ||
        item.scale.min >= item.scale.max
      ) {
        assessmentError("ASSESSMENT_SCALE_INVALID");
      }
    }
  }
}

/**
 * In-memory AssessmentComponent: the semantic reference for candidate →
 * publish → single attempt → deterministic grade → manual review.
 */
export function createInMemoryAssessmentComponent(input?: {
  now?: () => number;
}): AssessmentComponent {
  const now = input?.now ?? (() => Date.now());
  const candidates = new Map<string, AssessmentCandidate>();
  const assessments = new Map<string, AssessmentSnapshot>();
  const assessmentsByCandidate = new Map<string, string>();
  const attempts = new Map<string, AttemptSnapshot>();
  const attemptsByAssessmentLearner = new Map<string, string>();
  const grades = new Map<string, GradeSnapshot>();
  const reviewTasks = new Map<string, ReviewTask>();

  return {
    async composeCandidate(input) {
      validateCandidateItems(input.items);
      const id = nextId("candidate", now);
      const candidate: AssessmentCandidate = {
        id,
        courseId: input.courseId ?? null,
        sourceRunId: input.sourceRunId ?? null,
        items: input.items.map((item) => ({ ...item })),
        createdAt: new Date(now()).toISOString()
      };
      candidates.set(id, candidate);
      return candidate;
    },

    async publish(input) {
      const existingId = assessmentsByCandidate.get(input.candidateId);
      if (existingId !== undefined) {
        const existing = assessments.get(existingId);
        if (existing) return existing;
      }
      const candidate = candidates.get(input.candidateId);
      if (!candidate) assessmentError("ASSESSMENT_CANDIDATE_NOT_FOUND");
      if (typeof input.publishedBy !== "string" || input.publishedBy.length === 0) {
        assessmentError("ASSESSMENT_PUBLISHER_INVALID");
      }
      const id = nextId("assessment", now);
      const snapshot: AssessmentSnapshot = {
        id,
        candidateId: candidate.id,
        version: 1,
        items: candidate.items.map((item) => ({ ...item })),
        publishedAt: new Date(now()).toISOString()
      };
      assessments.set(id, snapshot);
      assessmentsByCandidate.set(candidate.id, id);
      return snapshot;
    },

    async submit(input) {
      const assessment = assessments.get(input.assessmentId);
      if (!assessment) assessmentError("ASSESSMENT_NOT_FOUND");
      const dedupeKey = `${input.assessmentId}::${input.learnerId}`;
      if (attemptsByAssessmentLearner.has(dedupeKey)) {
        assessmentError("ASSESSMENT_ATTEMPT_DUPLICATE");
      }
      const itemIds = new Set(assessment.items.map(({ id }) => id));
      const answered = new Set<string>();
      for (const answer of input.answers) {
        if (!itemIds.has(answer.itemId)) assessmentError("ASSESSMENT_ANSWER_ITEM_UNKNOWN");
        if (answered.has(answer.itemId)) assessmentError("ASSESSMENT_ANSWER_DUPLICATE");
        if (typeof answer.value !== "string" || answer.value.trim().length === 0) {
          assessmentError("ASSESSMENT_ANSWER_INVALID");
        }
        answered.add(answer.itemId);
      }
      for (const itemId of itemIds) {
        if (!answered.has(itemId)) assessmentError("ASSESSMENT_ANSWER_INCOMPLETE");
      }
      const id = nextId("attempt", now);
      const attempt: AttemptSnapshot = {
        id,
        assessmentId: input.assessmentId,
        learnerId: input.learnerId,
        answers: input.answers.map((answer) => ({ ...answer })),
        submittedAt: new Date(now()).toISOString()
      };
      attempts.set(id, attempt);
      attemptsByAssessmentLearner.set(dedupeKey, id);
      return attempt;
    },

    async gradeObjective(input) {
      const attempt = attempts.get(input.attemptId);
      if (!attempt) assessmentError("ASSESSMENT_ATTEMPT_NOT_FOUND");
      if (grades.has(input.attemptId)) return grades.get(input.attemptId) as GradeSnapshot;
      const assessment = assessments.get(attempt.assessmentId);
      if (!assessment) assessmentError("ASSESSMENT_NOT_FOUND");
      const keyById = new Map(assessment.items.map((item) => [item.id, item]));
      const answersById = new Map(attempt.answers.map((answer) => [answer.itemId, answer.value]));
      const id = nextId("grade", now);
      const grade: GradeSnapshot = {
        id,
        attemptId: attempt.id,
        perItem: attempt.answers.map(({ itemId }) => {
          const item = keyById.get(itemId);
          if (!item) assessmentError("ASSESSMENT_ANSWER_ITEM_UNKNOWN");
          if (item.kind !== "exact_response") {
            return { itemId, kind: item.kind, correct: null, gradedBy: "pending-review" as const };
          }
          return {
            itemId,
            kind: item.kind,
            correct: answersById.get(itemId) === item.expectedAnswer,
            gradedBy: "deterministic" as const
          };
        }),
        gradedAt: new Date(now()).toISOString()
      };
      grades.set(attempt.id, grade);
      return grade;
    },

    async requestReview(input) {
      const attempt = attempts.get(input.attemptId);
      if (!attempt) assessmentError("ASSESSMENT_ATTEMPT_NOT_FOUND");
      const assessment = assessments.get(attempt.assessmentId);
      if (!assessment) assessmentError("ASSESSMENT_NOT_FOUND");
      const item = assessment.items.find((candidate) => candidate.id === input.itemId);
      if (!item) assessmentError("ASSESSMENT_ANSWER_ITEM_UNKNOWN");
      if (item.kind !== "free_response") assessmentError("ASSESSMENT_REVIEW_ITEM_INVALID");
      const id = nextId("review", now);
      const task: ReviewTask = {
        id,
        attemptId: attempt.id,
        itemId: item.id,
        requestedAt: new Date(now()).toISOString()
      };
      reviewTasks.set(id, task);
      return task;
    }
  };
}
