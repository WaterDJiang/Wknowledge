import path from "node:path";
import type { ResolvedAgentSessionContext } from "@wknowledge/core";
import {
  createBoundKnowledgeComponent,
  type AgentCoreEvent,
  type AgentToolPolicyBridge,
  type BoundKnowledgeSearchContext,
  type KnowledgeComponent,
  type KnowledgeScopeKind
} from "@wknowledge/agent-runtime";

export type ServerAgentLoop = "pi" | "internal";

/**
 * Pi is the server's normal Agent Kernel. The legacy internal loop can only
 * be selected explicitly for an audited, time-bound incident rollback; it is
 * unrelated to the local SQLite App runtime profile.
 */
export function resolveServerAgentLoop(value: string | undefined): ServerAgentLoop {
  return value === "internal" ? "internal" : "pi";
}

/**
 * Pi-loop bypass wiring for the agent session route (S7 pre-switch path).
 * The default route still runs the internal loop; when the constant flips,
 * the same begin/SSE/settle scaffolding drives `runPiKnowledgeTurn` through
 * these helpers. All functions are pure and unit-tested so the switch is a
 * wiring review, not new behaviour.
 */

export function piTurnContexts(
  resolved: ResolvedAgentSessionContext,
  dataRootDir: string
): BoundKnowledgeSearchContext[] {
  return resolved.bindings.map(({ id, spaceId, scope, targetId, courseResourceVersionIds }) => ({
    bindingId: id,
    spaceId,
    spaceRoot: path.join(dataRootDir, spaceId),
    ...(scope === "wiki_page" && targetId ? { filter: { pageIds: [targetId] } } : {}),
    ...(scope === "resource_version" && targetId
      ? { filter: { resourceVersionIds: [targetId] } }
      : {}),
    ...(scope === "course" && courseResourceVersionIds?.length
      ? { filter: { resourceVersionIds: courseResourceVersionIds } }
      : {})
  }));
}

export function piSessionComponent(
  resolved: ResolvedAgentSessionContext,
  dataRootDir: string
): KnowledgeComponent {
  const contexts = piTurnContexts(resolved, dataRootDir);
  const rootsBySpace = new Map(contexts.map(({ spaceId, spaceRoot }) => [spaceId, spaceRoot]));
  const scopeKindFor = (bindingId: string): KnowledgeScopeKind => {
    const binding = resolved.bindings.find(({ id }) => id === bindingId);
    if (!binding) return "space";
    if (binding.scope === "wiki_page") return "wiki-page";
    if (binding.scope === "resource_version") return "resource-version";
    if (binding.scope === "course") return "course";
    return "space";
  };
  return createBoundKnowledgeComponent({
    scopes: contexts.map(({ bindingId, spaceId, filter }) => ({
      bindingId,
      kind: scopeKindFor(bindingId),
      spaceId,
      label: resolved.bindings.find(({ id }) => id === bindingId)?.label ?? spaceId,
      ...(filter !== undefined ? { filter } : {})
    })),
    resolveSpaceRoot: async (scope) => {
      const root = rootsBySpace.get(scope.spaceId);
      if (root === undefined) throw new Error("AGENT_CONTEXT_INVALID");
      return root;
    },
    openSource: async (input) => ({
      bindingId: input.scope.bindingId,
      spaceId: input.scope.spaceId,
      evidenceId: input.evidenceId,
      sourceIndex: input.sourceIndex,
      sourceRef: input.sourceRef
    })
  });
}

/**
 * Revocation recheck as the policy gate: every tool call re-asserts the
 * session bindings are still readable; a revocation denies with the original
 * stable code and terminates the run instead of leaking the denial shape.
 */
export function piSessionPolicyBridge(input: {
  assertReadable: () => Promise<void>;
}): AgentToolPolicyBridge {
  return {
    async beforeToolCall() {
      try {
        await input.assertReadable();
        return { allow: true };
      } catch (error) {
        const code = error instanceof Error ? error.message : "AGENT_SESSION_ACCESS_REVOKED";
        return {
          allow: false,
          code: /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "AGENT_SESSION_ACCESS_REVOKED",
          terminate: true
        };
      }
    },
    async afterToolCall() {
      return {};
    }
  };
}

export interface PiToolCallRecordInput {
  name: "knowledge.search" | "knowledge.read";
  inputSummary: string;
  outputSummary: string;
  resultCount: number;
  searchedPages: number;
}

/**
 * Derives the tool-call records `completeAgentSessionRun` persists from the
 * mapped Pi event stream plus the finalized evidence bundle.
 */
export function knowledgeToolCallRecords(
  events: readonly AgentCoreEvent[],
  input: { searchedPages: number; evidenceCount: number; bindingCount: number }
): PiToolCallRecordInput[] {
  const records: PiToolCallRecordInput[] = [];
  for (const event of events) {
    if (event.type === "tool.requested" && event.tool === "knowledge.search") {
      records.push({
        name: "knowledge.search",
        inputSummary: `在 ${input.bindingCount} 个受管知识范围中检索`,
        outputSummary: `检索 ${input.searchedPages} 页，得到 ${input.evidenceCount} 条候选`,
        resultCount: input.evidenceCount,
        searchedPages: input.searchedPages
      });
    }
    if (event.type === "tool.requested" && event.tool === "knowledge.read") {
      let readCount = 0;
      try {
        const parsed = JSON.parse(event.inputSummary) as { evidenceIds?: unknown };
        readCount = Array.isArray(parsed.evidenceIds) ? parsed.evidenceIds.length : 0;
      } catch {
        readCount = 0;
      }
      const count = readCount || input.evidenceCount;
      records.push({
        name: "knowledge.read",
        inputSummary: `读取 ${count} 个已检索证据片段`,
        outputSummary: `读取 ${count} 个已检索证据片段`,
        resultCount: count,
        searchedPages: count
      });
    }
  }
  return records;
}

export type PiStreamEmitEvent =
  | {
      type: "tool.requested";
      runId: string;
      tool: "knowledge.search" | "knowledge.read";
      inputSummary: string;
    }
  | {
      type: "tool.completed";
      runId: string;
      tool: "knowledge.search" | "knowledge.read";
      outputSummary: string;
    };

/** Maps the folded Pi event stream onto the SSE tool events the UI consumes. */
export function piToolStreamEvents(
  events: readonly AgentCoreEvent[],
  runId: string,
  input: { searchedPages: number; evidenceCount: number }
): PiStreamEmitEvent[] {
  const toolByCallId = new Map<string, "knowledge.search" | "knowledge.read">();
  for (const event of events) {
    if (
      event.type === "tool.requested" &&
      (event.tool === "knowledge.search" || event.tool === "knowledge.read")
    ) {
      toolByCallId.set(event.toolCallId, event.tool);
    }
  }
  const emitted: PiStreamEmitEvent[] = [];
  for (const event of events) {
    if (
      event.type === "tool.requested" &&
      (event.tool === "knowledge.search" || event.tool === "knowledge.read")
    ) {
      emitted.push({
        type: "tool.requested",
        runId,
        tool: event.tool,
        inputSummary:
          event.tool === "knowledge.search" ? "在已绑定知识空间中检索" : "读取已检索的受管证据片段"
      });
    }
    if (event.type === "tool.completed") {
      const tool = toolByCallId.get(event.toolCallId) ?? "knowledge.search";
      let readCount = 0;
      if (tool === "knowledge.read") {
        try {
          const parsed = JSON.parse(event.outputSummary) as { resultCount?: unknown };
          readCount = typeof parsed.resultCount === "number" ? parsed.resultCount : 0;
        } catch {
          readCount = 0;
        }
      }
      emitted.push({
        type: "tool.completed",
        runId,
        tool,
        outputSummary:
          tool === "knowledge.search"
            ? `已检索 ${input.searchedPages} 页，得到 ${input.evidenceCount} 条候选`
            : `已读取 ${readCount || input.evidenceCount} 条受管证据片段`
      });
    }
  }
  return emitted;
}
