import type { AgentKnowledgeToolCall } from "@wknowledge/contracts";

export interface AssistantToolStep {
  name: AgentKnowledgeToolCall["name"];
  outputSummary: string;
}

export type AssistantToolStage = "searching" | "reading" | "answering";

const TOOL_ORDER: Record<AssistantToolStep["name"], number> = {
  "knowledge.search": 0,
  "knowledge.read": 1
};

export function toolStepsForRun(
  toolCalls: readonly AgentKnowledgeToolCall[],
  runId: string
): AssistantToolStep[] {
  return toolCalls
    .filter((toolCall) => toolCall.agentRunId === runId)
    .sort((left, right) => TOOL_ORDER[left.name] - TOOL_ORDER[right.name])
    .map(({ name, outputSummary }) => ({ name, outputSummary }));
}

export function stageForRequestedTool(tool: AgentKnowledgeToolCall["name"]): AssistantToolStage {
  return tool === "knowledge.read" ? "reading" : "searching";
}

export function assistantStageLabel(stage: "starting" | AssistantToolStage): string {
  if (stage === "searching") return "检索中";
  if (stage === "reading") return "阅读依据中";
  return "生成中";
}
