import {
  agentContextBindingSchema,
  agentKnowledgeToolCallSchema,
  agentEvidenceSnapshotSchema,
  agentMessageSchema,
  agentRunSchema,
  agentSessionSummarySchema,
  type AgentContextBinding,
  type AgentContextScope,
  type AgentKnowledgeToolCall,
  type AgentEvidenceSnapshot,
  type AgentMessage,
  type AgentRun,
  type AgentSessionSummary
} from "@wknowledge/contracts";

type SessionRecord = {
  id: string;
  title: string;
  status: "active" | "archived";
  createdAt: Date;
  updatedAt: Date;
};

export function presentAgentSessionSummary(input: {
  session: SessionRecord;
  bindingCount: number;
  lastMessageAt: Date | null;
}): AgentSessionSummary {
  return agentSessionSummarySchema.parse({
    id: input.session.id,
    title: input.session.title,
    status: input.session.status,
    bindingCount: input.bindingCount,
    lastMessageAt: input.lastMessageAt?.toISOString() ?? null,
    createdAt: input.session.createdAt.toISOString(),
    updatedAt: input.session.updatedAt.toISOString()
  });
}

export function presentAgentContextBinding(input: {
  id: string;
  spaceId: string;
  scope: AgentContextScope;
  targetId: string | null;
  label: string;
  virtualPath: string;
  status: "active" | "removed" | "revoked";
  createdAt: Date;
}): AgentContextBinding {
  return agentContextBindingSchema.parse({ ...input, createdAt: input.createdAt.toISOString() });
}

export function presentAgentKnowledgeToolCall(input: {
  id: string;
  agentRunId: string;
  name: "knowledge.search" | "knowledge.read";
  bindingIds: string[];
  inputSummary: string;
  outputSummary: string;
  resultCount: number;
  searchedPages: number;
  durationMs: number;
  completedAt: Date;
}): AgentKnowledgeToolCall {
  return agentKnowledgeToolCallSchema.parse({
    ...input,
    completedAt: input.completedAt.toISOString()
  });
}

export function presentAgentMessage(input: {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}): AgentMessage {
  return agentMessageSchema.parse({ ...input, createdAt: input.createdAt.toISOString() });
}

export function presentAgentEvidenceSnapshot(input: {
  id: string;
  evidenceId: string;
  spaceId: string;
  pageId: string;
  pageTitle: string;
  pageType: "concept" | "topic" | "case" | "course" | "material";
  rank: number;
  sourceCount: number;
  sourceRefs: string[];
  cited: boolean;
}): AgentEvidenceSnapshot {
  return agentEvidenceSnapshotSchema.parse(input);
}

export function presentAgentRun(input: {
  id: string;
  userMessageId: string;
  assistantMessageId: string | null;
  status: "running" | "completed" | "failed" | "stopped";
  answerMode: "generated" | "extractive_fallback" | null;
  insufficientEvidence: boolean | null;
  searchedPages: number;
  embeddingCalls: number;
  durationMs: number;
  errorCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
  evidence: AgentEvidenceSnapshot[];
}): AgentRun {
  return agentRunSchema.parse({
    ...input,
    embeddingCalls: 0,
    createdAt: input.createdAt.toISOString(),
    completedAt: input.completedAt?.toISOString() ?? null
  });
}
