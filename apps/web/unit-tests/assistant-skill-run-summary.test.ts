import { describe, expect, it } from "vitest";
import type { SkillRun } from "@wknowledge/contracts";
import {
  completedSkillRunSummary,
  skillRunStatusLabel
} from "../app/workspace/assistant-skill-run-summary";

const baseRun: SkillRun = {
  id: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  skillId: "example-skill",
  skillVersion: "1.0.0",
  skillDigest: `sha256:${"a".repeat(64)}`,
  bindingIds: ["33333333-3333-4333-8333-333333333333"],
  approvalId: null,
  inputSummary: "受管摘要",
  status: "completed",
  errorCode: null,
  outputSummary: {
    runtime: "node",
    bindingCount: 1,
    outputType: "object",
    outputKeyCount: 2,
    networkCalls: 0,
    modelCalls: 0
  },
  queuedAt: "2026-08-14T00:00:00.000Z",
  startedAt: "2026-08-14T00:00:01.000Z",
  completedAt: "2026-08-14T00:00:02.000Z"
};

describe("assistant Skill run summaries", () => {
  it("shows a dynamic Skill completion summary without output body", () => {
    expect(completedSkillRunSummary(baseRun)).toBe(
      "已在受管 node 运行时完成 1 个知识范围的处理 · 输出为 object"
    );
  });

  it("preserves the dedicated wiki lint summary and neutral status labels", () => {
    expect(
      completedSkillRunSummary({
        ...baseRun,
        skillId: "wiki-lint",
        outputSummary: { scannedSpaces: 2, issueCount: 3 }
      })
    ).toBe("已检查 2 个知识空间，发现 3 个结构问题");
    expect(skillRunStatusLabel({ ...baseRun, status: "running", completedAt: null })).toBe(
      "受管运行时处理中"
    );
  });
});
