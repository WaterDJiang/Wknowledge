/**
 * Learning component port (M6-15, upgrade spec §4.3).
 *
 * Goals, plans, course structure, learning events, progress and reports are
 * owned by the domain. Skills may only propose plan candidates; plan
 * activation, progress and report metrics are written deterministically by
 * the component and can never be overridden by a model. The in-memory
 * implementation is the semantic reference for the database-backed adapter.
 */

export interface LearningPlanCandidateUnit {
  id: string;
  title: string;
  knowledgePointId: string;
  resourceVersionId: string;
}

export interface LearningPlanCandidate {
  id: string;
  learnerId: string;
  goal: string;
  units: readonly LearningPlanCandidateUnit[];
  sourceRunId: string | null;
  createdAt: string;
}

export interface ActiveLearningPlan {
  id: string;
  candidateId: string;
  learnerId: string;
  goal: string;
  units: readonly LearningPlanCandidateUnit[];
  confirmedAt: string;
}

export type LearningEventKind =
  "unit_completed" | "media_progressed" | "practice_completed" | "assessment_graded";

export interface LearningEvent {
  id: string;
  planId: string;
  kind: LearningEventKind;
  unitId: string | null;
  occurredAt: string;
  sequence: number;
  detail: Record<string, string | number | boolean>;
}

export interface LearningProgress {
  planId: string;
  completedUnitIds: readonly string[];
  totalUnits: number;
  latestMediaPositionMsByUnit: Readonly<Record<string, number>>;
}

export interface LearningReportSnapshot {
  id: string;
  planId: string;
  derivedFromEventCount: number;
  completedUnits: number;
  totalUnits: number;
  generatedAt: string;
}

export interface LearningComponent {
  composePlanCandidate(input: {
    learnerId: string;
    goal: string;
    units: readonly LearningPlanCandidateUnit[];
    sourceRunId?: string;
  }): Promise<LearningPlanCandidate>;
  confirmPlan(input: { candidateId: string }): Promise<ActiveLearningPlan>;
  recordLearningEvent(input: {
    planId: string;
    kind: LearningEventKind;
    unitId?: string;
    detail?: Record<string, string | number | boolean>;
  }): Promise<LearningEvent>;
  currentProgress(input: { planId: string }): Promise<LearningProgress>;
  snapshotReport(input: { planId: string }): Promise<LearningReportSnapshot>;
}

function learningError(code: string): never {
  throw new Error(code);
}

function validateCandidateUnits(units: readonly LearningPlanCandidateUnit[]): void {
  if (!Array.isArray(units) || units.length === 0) learningError("LEARNING_PLAN_UNITS_EMPTY");
  const seen = new Set<string>();
  for (const unit of units) {
    if (typeof unit.id !== "string" || unit.id.length === 0 || seen.has(unit.id)) {
      learningError("LEARNING_UNIT_ID_INVALID");
    }
    seen.add(unit.id);
    if (unit.title.trim().length === 0) learningError("LEARNING_UNIT_TITLE_INVALID");
    if (unit.knowledgePointId.length === 0 || unit.resourceVersionId.length === 0) {
      learningError("LEARNING_UNIT_SOURCE_INVALID");
    }
  }
}

/**
 * In-memory LearningComponent: candidate → confirmed plan → append-only
 * events → derived progress → immutable report snapshots.
 */
export function createInMemoryLearningComponent(input?: { now?: () => number }): LearningComponent {
  const now = input?.now ?? (() => Date.now());
  const candidates = new Map<string, LearningPlanCandidate>();
  const plans = new Map<string, ActiveLearningPlan>();
  const plansByCandidate = new Map<string, string>();
  const plansByLearner = new Map<string, string>();
  const eventsByPlan = new Map<string, LearningEvent[]>();
  const reports = new Map<string, LearningReportSnapshot>();
  let sequence = 0;

  function eventsOf(planId: string): LearningEvent[] {
    return eventsByPlan.get(planId) ?? [];
  }

  function deriveProgress(planId: string): LearningProgress {
    const plan = plans.get(planId);
    if (!plan) learningError("LEARNING_PLAN_NOT_FOUND");
    const completed = new Set<string>();
    const mediaPositions: Record<string, number> = {};
    for (const event of eventsOf(planId)) {
      if (event.kind === "unit_completed" && event.unitId !== null) {
        completed.add(event.unitId);
      }
      if (event.kind === "media_progressed" && event.unitId !== null) {
        const position = event.detail.positionMs;
        if (typeof position === "number") mediaPositions[event.unitId] = position;
      }
    }
    return {
      planId,
      completedUnitIds: [...completed].sort(),
      totalUnits: plan.units.length,
      latestMediaPositionMsByUnit: mediaPositions
    };
  }

  return {
    async composePlanCandidate(candidateInput) {
      if (candidateInput.goal.trim().length === 0) learningError("LEARNING_GOAL_INVALID");
      if (candidateInput.learnerId.length === 0) learningError("LEARNING_LEARNER_INVALID");
      validateCandidateUnits(candidateInput.units);
      sequence += 1;
      const id = `plan-candidate-${sequence.toString().padStart(8, "0")}`;
      const candidate: LearningPlanCandidate = {
        id,
        learnerId: candidateInput.learnerId,
        goal: candidateInput.goal,
        units: candidateInput.units.map((unit) => ({ ...unit })),
        sourceRunId: candidateInput.sourceRunId ?? null,
        createdAt: new Date(now()).toISOString()
      };
      candidates.set(id, candidate);
      return candidate;
    },

    async confirmPlan(confirmInput) {
      const existingId = plansByCandidate.get(confirmInput.candidateId);
      if (existingId !== undefined) {
        const existing = plans.get(existingId);
        if (existing) return existing;
      }
      const candidate = candidates.get(confirmInput.candidateId);
      if (!candidate) learningError("LEARNING_CANDIDATE_NOT_FOUND");
      if (plansByLearner.has(candidate.learnerId)) {
        learningError("LEARNING_PLAN_ALREADY_ACTIVE");
      }
      sequence += 1;
      const id = `plan-${sequence.toString().padStart(8, "0")}`;
      const plan: ActiveLearningPlan = {
        id,
        candidateId: candidate.id,
        learnerId: candidate.learnerId,
        goal: candidate.goal,
        units: candidate.units.map((unit) => ({ ...unit })),
        confirmedAt: new Date(now()).toISOString()
      };
      plans.set(id, plan);
      plansByCandidate.set(candidate.id, id);
      plansByLearner.set(candidate.learnerId, id);
      eventsByPlan.set(id, []);
      return plan;
    },

    async recordLearningEvent(eventInput) {
      const plan = plans.get(eventInput.planId);
      if (!plan) learningError("LEARNING_PLAN_NOT_FOUND");
      const unitIds = new Set(plan.units.map(({ id }) => id));
      const unitId = eventInput.unitId ?? null;
      if (unitId !== null && !unitIds.has(unitId)) learningError("LEARNING_UNIT_UNKNOWN");
      if (eventInput.kind === "unit_completed" && unitId === null) {
        learningError("LEARNING_UNIT_REQUIRED");
      }
      if (eventInput.kind === "media_progressed") {
        if (unitId === null) learningError("LEARNING_UNIT_REQUIRED");
        const position = eventInput.detail?.positionMs;
        if (typeof position !== "number" || !Number.isFinite(position) || position < 0) {
          learningError("LEARNING_EVENT_DETAIL_INVALID");
        }
      }
      const planEvents = eventsByPlan.get(eventInput.planId) ?? [];
      const event: LearningEvent = {
        id: `event-${planEvents.length + 1}`,
        planId: eventInput.planId,
        kind: eventInput.kind,
        unitId,
        occurredAt: new Date(now()).toISOString(),
        sequence: planEvents.length + 1,
        detail: eventInput.detail ?? {}
      };
      planEvents.push(event);
      eventsByPlan.set(eventInput.planId, planEvents);
      return event;
    },

    async currentProgress(progressInput) {
      return deriveProgress(progressInput.planId);
    },

    async snapshotReport(reportInput) {
      const existing = reports.get(reportInput.planId);
      if (existing) return existing;
      const progress = deriveProgress(reportInput.planId);
      const report: LearningReportSnapshot = {
        id: `report-${reportInput.planId}`,
        planId: reportInput.planId,
        derivedFromEventCount: eventsOf(reportInput.planId).length,
        completedUnits: progress.completedUnitIds.length,
        totalUnits: progress.totalUnits,
        generatedAt: new Date(now()).toISOString()
      };
      reports.set(reportInput.planId, report);
      return report;
    }
  };
}
