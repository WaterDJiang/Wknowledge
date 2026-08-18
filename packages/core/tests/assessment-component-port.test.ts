import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createInMemoryAssessmentComponent } from "../src/assessment-component-port";
import type { AssessmentCandidateItem } from "../src/assessment-component-port";

function locatorFor(resourceVersionId: string) {
  return { type: "document" as const, resourceVersionId, nodeId: "node-1" };
}

function items(resourceVersionId: string): AssessmentCandidateItem[] {
  return [
    {
      id: "item-exact",
      kind: "exact_response",
      prompt: "间隔检索的推荐频率是？",
      knowledgePointId: "kp-1",
      resourceVersionId,
      locator: locatorFor(resourceVersionId),
      expectedAnswer: "每天"
    },
    {
      id: "item-free",
      kind: "free_response",
      prompt: "请解释为什么间隔检索有效。",
      knowledgePointId: "kp-2",
      resourceVersionId,
      locator: locatorFor(resourceVersionId),
      scale: { min: 0, max: 5 }
    }
  ];
}

describe("assessment component port", () => {
  it("composes a candidate only from well-formed sourced items", async () => {
    const component = createInMemoryAssessmentComponent();
    const resourceVersionId = randomUUID();
    const candidate = await component.composeCandidate({
      sourceRunId: "run-1",
      items: items(resourceVersionId)
    });
    expect(candidate.items).toHaveLength(2);
    expect(
      candidate.items.every((item) => item.locator.resourceVersionId === resourceVersionId)
    ).toBe(true);
  });

  it.each([
    { label: "no items", input: { items: [] } },
    {
      label: "a duplicate item id",
      input: {
        items: (() => {
          const [first] = items(randomUUID());
          return [first!, { ...first! }];
        })()
      }
    },
    {
      label: "an exact-response item without an answer key",
      input: {
        items: (() => {
          const [first] = items(randomUUID());
          const { expectedAnswer, ...rest } = first!;
          void expectedAnswer;
          return [{ ...rest, kind: "exact_response" as const }];
        })()
      }
    },
    {
      label: "a free-response item without a scale",
      input: {
        items: [
          {
            id: "item-free",
            kind: "free_response" as const,
            prompt: "解释。",
            knowledgePointId: "kp",
            resourceVersionId: randomUUID(),
            locator: locatorFor(randomUUID())
          }
        ]
      }
    }
  ])("rejects $label at candidate time", async ({ input }) => {
    const component = createInMemoryAssessmentComponent();
    await expect(component.composeCandidate(input)).rejects.toThrow(/^ASSESSMENT_/);
  });

  it("publishes each candidate once as an immutable snapshot", async () => {
    const component = createInMemoryAssessmentComponent();
    const candidate = await component.composeCandidate({ items: items(randomUUID()) });
    const first = await component.publish({ candidateId: candidate.id, publishedBy: "admin" });
    const replay = await component.publish({ candidateId: candidate.id, publishedBy: "admin" });
    expect(replay.id).toBe(first.id);
    expect(replay.items).toEqual(first.items);
    await expect(
      component.publish({ candidateId: "missing", publishedBy: "admin" })
    ).rejects.toThrow("ASSESSMENT_CANDIDATE_NOT_FOUND");
  });

  it("accepts exactly one complete attempt per learner and assessment", async () => {
    const component = createInMemoryAssessmentComponent();
    const resourceVersionId = randomUUID();
    const candidate = await component.composeCandidate({ items: items(resourceVersionId) });
    const assessment = await component.publish({ candidateId: candidate.id, publishedBy: "admin" });
    const answers = [
      { itemId: "item-exact", value: "每天" },
      { itemId: "item-free", value: "因为记忆会随时间衰减。" }
    ];
    const attempt = await component.submit({
      assessmentId: assessment.id,
      learnerId: "learner-1",
      answers
    });
    expect(attempt.answers).toEqual(answers);
    await expect(
      component.submit({ assessmentId: assessment.id, learnerId: "learner-1", answers })
    ).rejects.toThrow("ASSESSMENT_ATTEMPT_DUPLICATE");
    await expect(
      component.submit({
        assessmentId: assessment.id,
        learnerId: "learner-2",
        answers: [answers[0]!]
      })
    ).rejects.toThrow("ASSESSMENT_ANSWER_INCOMPLETE");
    await expect(
      component.submit({
        assessmentId: assessment.id,
        learnerId: "learner-2",
        answers: [...answers, { itemId: "item-exact", value: "重复" }]
      })
    ).rejects.toThrow("ASSESSMENT_ANSWER_DUPLICATE");
  });

  it("grades objective items deterministically and defers free responses", async () => {
    const component = createInMemoryAssessmentComponent();
    const candidate = await component.composeCandidate({ items: items(randomUUID()) });
    const assessment = await component.publish({ candidateId: candidate.id, publishedBy: "admin" });
    const attempt = await component.submit({
      assessmentId: assessment.id,
      learnerId: "learner-1",
      answers: [
        { itemId: "item-exact", value: "每周" },
        { itemId: "item-free", value: "记忆衰减。" }
      ]
    });
    const grade = await component.gradeObjective({ attemptId: attempt.id });
    expect(grade.perItem).toEqual([
      { itemId: "item-exact", kind: "exact_response", correct: false, gradedBy: "deterministic" },
      { itemId: "item-free", kind: "free_response", correct: null, gradedBy: "pending-review" }
    ]);
    const replay = await component.gradeObjective({ attemptId: attempt.id });
    expect(replay).toEqual(grade);
  });

  it("routes only free-response items to manual review", async () => {
    const component = createInMemoryAssessmentComponent();
    const candidate = await component.composeCandidate({ items: items(randomUUID()) });
    const assessment = await component.publish({ candidateId: candidate.id, publishedBy: "admin" });
    const attempt = await component.submit({
      assessmentId: assessment.id,
      learnerId: "learner-1",
      answers: [
        { itemId: "item-exact", value: "每天" },
        { itemId: "item-free", value: "记忆衰减。" }
      ]
    });
    const task = await component.requestReview({ attemptId: attempt.id, itemId: "item-free" });
    expect(task).toMatchObject({ attemptId: attempt.id, itemId: "item-free" });
    await expect(
      component.requestReview({ attemptId: attempt.id, itemId: "item-exact" })
    ).rejects.toThrow("ASSESSMENT_REVIEW_ITEM_INVALID");
  });
});
