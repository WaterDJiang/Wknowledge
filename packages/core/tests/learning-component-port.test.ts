import { describe, expect, it } from "vitest";
import { createInMemoryLearningComponent } from "../src/learning-component-port";
import type { LearningPlanCandidateUnit } from "../src/learning-component-port";

function units(): LearningPlanCandidateUnit[] {
  return [
    {
      id: "unit-1",
      title: "间隔检索",
      knowledgePointId: "kp-1",
      resourceVersionId: "version-1"
    },
    {
      id: "unit-2",
      title: "主动回忆",
      knowledgePointId: "kp-2",
      resourceVersionId: "version-1"
    }
  ];
}

async function confirmedPlan(component: ReturnType<typeof createInMemoryLearningComponent>) {
  const candidate = await component.composePlanCandidate({
    learnerId: "learner-1",
    goal: "掌握学习方法",
    units: units()
  });
  return component.confirmPlan({ candidateId: candidate.id });
}

describe("learning component port", () => {
  it("composes plan candidates only from well-formed sourced units", async () => {
    const component = createInMemoryLearningComponent();
    const candidate = await component.composePlanCandidate({
      learnerId: "learner-1",
      goal: "掌握学习方法",
      units: units(),
      sourceRunId: "run-1"
    });
    expect(candidate.units).toHaveLength(2);
    await expect(
      component.composePlanCandidate({ learnerId: "learner-1", goal: " ", units: units() })
    ).rejects.toThrow("LEARNING_GOAL_INVALID");
    await expect(
      component.composePlanCandidate({
        learnerId: "learner-1",
        goal: "目标",
        units: [units()[0]!, { ...units()[0]! }]
      })
    ).rejects.toThrow("LEARNING_UNIT_ID_INVALID");
  });

  it("confirms each candidate once and keeps one active plan per learner", async () => {
    const component = createInMemoryLearningComponent();
    const plan = await confirmedPlan(component);
    const replay = await component.confirmPlan({ candidateId: plan.candidateId });
    expect(replay.id).toBe(plan.id);
    const second = await component.composePlanCandidate({
      learnerId: "learner-1",
      goal: "第二计划",
      units: units()
    });
    await expect(component.confirmPlan({ candidateId: second.id })).rejects.toThrow(
      "LEARNING_PLAN_ALREADY_ACTIVE"
    );
    await expect(component.confirmPlan({ candidateId: "missing" })).rejects.toThrow(
      "LEARNING_CANDIDATE_NOT_FOUND"
    );
  });

  it("appends ordered learning events with validated shapes", async () => {
    const component = createInMemoryLearningComponent();
    const plan = await confirmedPlan(component);
    const first = await component.recordLearningEvent({
      planId: plan.id,
      kind: "unit_completed",
      unitId: "unit-1"
    });
    const second = await component.recordLearningEvent({
      planId: plan.id,
      kind: "media_progressed",
      unitId: "unit-2",
      detail: { positionMs: 30_000 }
    });
    expect(second.sequence).toBe(first.sequence + 1);
    await expect(
      component.recordLearningEvent({ planId: plan.id, kind: "unit_completed" })
    ).rejects.toThrow("LEARNING_UNIT_REQUIRED");
    await expect(
      component.recordLearningEvent({
        planId: plan.id,
        kind: "media_progressed",
        unitId: "unit-2",
        detail: { positionMs: -1 }
      })
    ).rejects.toThrow("LEARNING_EVENT_DETAIL_INVALID");
    await expect(
      component.recordLearningEvent({ planId: plan.id, kind: "unit_completed", unitId: "nope" })
    ).rejects.toThrow("LEARNING_UNIT_UNKNOWN");
  });

  it("derives progress deterministically from the event log", async () => {
    const component = createInMemoryLearningComponent();
    const plan = await confirmedPlan(component);
    await component.recordLearningEvent({
      planId: plan.id,
      kind: "media_progressed",
      unitId: "unit-1",
      detail: { positionMs: 10_000 }
    });
    await component.recordLearningEvent({
      planId: plan.id,
      kind: "media_progressed",
      unitId: "unit-1",
      detail: { positionMs: 25_000 }
    });
    await component.recordLearningEvent({
      planId: plan.id,
      kind: "unit_completed",
      unitId: "unit-1"
    });
    const progress = await component.currentProgress({ planId: plan.id });
    expect(progress).toEqual({
      planId: plan.id,
      completedUnitIds: ["unit-1"],
      totalUnits: 2,
      latestMediaPositionMsByUnit: { "unit-1": 25_000 }
    });
  });

  it("freezes report snapshots that later events cannot rewrite", async () => {
    const component = createInMemoryLearningComponent();
    const plan = await confirmedPlan(component);
    await component.recordLearningEvent({
      planId: plan.id,
      kind: "unit_completed",
      unitId: "unit-1"
    });
    const snapshot = await component.snapshotReport({ planId: plan.id });
    expect(snapshot).toMatchObject({ completedUnits: 1, totalUnits: 2, derivedFromEventCount: 1 });
    await component.recordLearningEvent({
      planId: plan.id,
      kind: "unit_completed",
      unitId: "unit-2"
    });
    const replay = await component.snapshotReport({ planId: plan.id });
    expect(replay).toEqual(snapshot);
    const progress = await component.currentProgress({ planId: plan.id });
    expect(progress.completedUnitIds).toEqual(["unit-1", "unit-2"]);
  });
});
