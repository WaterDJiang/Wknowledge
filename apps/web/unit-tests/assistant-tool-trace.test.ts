import { describe, expect, it } from "vitest";
import type { AgentKnowledgeToolCall } from "@wknowledge/contracts";
import {
  assistantStageLabel,
  stageForRequestedTool,
  toolStepsForRun
} from "../app/workspace/assistant-tool-trace";

const runId = "11111111-1111-4111-8111-111111111111";

function toolCall(
  name: AgentKnowledgeToolCall["name"],
  agentRunId = runId
): AgentKnowledgeToolCall {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    agentRunId,
    name,
    bindingIds: ["33333333-3333-4333-8333-333333333333"],
    inputSummary: "在 1 个受管知识范围中检索",
    outputSummary:
      name === "knowledge.search" ? "检索 3 页，得到 2 条候选" : "读取 2 个受管证据片段",
    resultCount: 2,
    searchedPages: 3,
    durationMs: 1,
    completedAt: "2026-08-14T00:00:00.000Z"
  };
}

describe("assistant tool trace", () => {
  it("keeps a run's search then read trace in a stable order", () => {
    expect(
      toolStepsForRun([toolCall("knowledge.read"), toolCall("knowledge.search")], runId)
    ).toEqual([
      { name: "knowledge.search", outputSummary: "检索 3 页，得到 2 条候选" },
      { name: "knowledge.read", outputSummary: "读取 2 个受管证据片段" }
    ]);
  });

  it("does not show another run's tool metadata", () => {
    expect(
      toolStepsForRun([toolCall("knowledge.search", "44444444-4444-4444-8444-444444444444")], runId)
    ).toEqual([]);
  });

  it("labels the protected evidence read step separately from search", () => {
    expect(stageForRequestedTool("knowledge.search")).toBe("searching");
    expect(stageForRequestedTool("knowledge.read")).toBe("reading");
    expect(assistantStageLabel("reading")).toBe("阅读依据中");
  });
});
