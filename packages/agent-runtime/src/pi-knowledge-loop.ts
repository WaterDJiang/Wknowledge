import {
  agentLoop,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage
} from "@earendil-works/pi-agent-core";
import type { DataPolicy, EvidenceBundle, GroundedQueryResult } from "@wknowledge/contracts";
import type { ModelGateway, ModelRequest, ModelResponse } from "@wknowledge/model-gateway";
import { createAgentToolRegistry } from "./agent-tool-registry";
import type { AgentToolPolicyBridge } from "./agent-tool-registry";
import type { AgentModelCall } from "./index";
import { createGatewayStreamFn } from "./model-gateway-bridge";
import {
  compactAgentConversation,
  extractiveFallback,
  finalizeGroundedAnswer,
  type KnowledgeComponent,
  type KnowledgeConversationMessage
} from "./knowledge-component";
import { createKnowledgeTools } from "./knowledge-tools";
import { mapPiAgentEvent, piTerminalAgentCoreEvent } from "./pi-adapter";
import type { AgentCoreEvent } from "./agent-core";

/**
 * Production Pi conversation loop for one knowledge turn (M5-16 → S7 switch
 * path): composes the KnowledgeComponent, knowledge.* tools, the tool
 * registry with the Wknowledge policy bridge, the Model Gateway stream
 * function and the shared event mapping into a single callable. The evidence
 * bundle is built once up front (same as the internal loop) and the search
 * tool replays exactly that bundle. Returns the full mapped AgentCoreEvent
 * stream (for run-event projection) and the finalized GroundedQueryResult —
 * never an ungrounded answer.
 */

const LOOP_MODEL = {
  id: "gateway",
  name: "gateway",
  api: "wknowledge-gateway",
  provider: "wknowledge",
  baseUrl: "gateway://wknowledge",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 4096
} as AgentLoopConfig["model"];

export interface PiKnowledgeTurnResult {
  events: AgentCoreEvent[];
  result: GroundedQueryResult;
  modelCall: AgentModelCall;
}

function recordingGateway(gateway: ModelGateway): {
  gateway: ModelGateway;
  modelCall: () => AgentModelCall;
} {
  let totalDurationMs = 0;
  let last: { providerId: string; model: string } | null = null;
  let failed: string | null = null;
  return {
    gateway: {
      invoke(request: ModelRequest): Promise<ModelResponse> {
        return gateway.invoke(request).then(
          (response: ModelResponse) => {
            totalDurationMs += response.durationMs;
            last = { providerId: response.providerId, model: response.model };
            return response;
          },
          (error: unknown) => {
            totalDurationMs += 1;
            failed =
              error instanceof Error && /^[A-Z][A-Z0-9_]*$/.test(error.message)
                ? error.message
                : "MODEL_GATEWAY_FAILED";
            throw error;
          }
        );
      }
    } as unknown as ModelGateway,
    modelCall: () =>
      failed !== null
        ? {
            status: "failed",
            providerId: last?.providerId ?? null,
            model: last?.model ?? null,
            durationMs: totalDurationMs,
            errorCode: failed
          }
        : last !== null
          ? {
              status: "succeeded",
              providerId: last.providerId,
              model: last.model,
              durationMs: totalDurationMs
            }
          : null
  };
}

function lastAssistantText(events: readonly AgentCoreEvent[]): string | null {
  let text: string | null = null;
  for (const event of events) {
    if (event.type === "assistant.delta") text = (text ?? "") + event.text;
  }
  return text;
}

export async function runPiKnowledgeTurn(input: {
  runId: string;
  component: KnowledgeComponent;
  gateway: ModelGateway | null;
  dataPolicy: DataPolicy;
  question: string;
  policy: AgentToolPolicyBridge;
  conversation?: readonly KnowledgeConversationMessage[];
  signal?: AbortSignal;
}): Promise<PiKnowledgeTurnResult> {
  const evidence: EvidenceBundle = await input.component.search({
    question: input.question,
    ...(input.signal !== undefined ? { signal: input.signal } : {})
  });
  if (input.gateway === null || evidence.items.length === 0) {
    return {
      events: [
        { type: "run.started", runId: input.runId },
        { type: "run.completed", runId: input.runId }
      ],
      result: extractiveFallback(evidence),
      modelCall: null
    };
  }

  // Within one turn the model sees exactly the bundle built up front — the
  // same behaviour as the internal loop — so the search tool replays it
  // instead of re-querying the wiki.
  const pinnedComponent: KnowledgeComponent = {
    ...input.component,
    search: async () => evidence
  };

  const registry = createAgentToolRegistry();
  for (const tool of createKnowledgeTools(pinnedComponent, {
    question: input.question,
    ...(input.signal !== undefined ? { signal: input.signal } : {})
  })) {
    registry.register(tool);
  }
  const recorder = recordingGateway(input.gateway);
  const events: AgentCoreEvent[] = [{ type: "run.started", runId: input.runId }];
  try {
    // Bounded history is untrusted intent context only — it never becomes
    // evidence or a permission source (same contract as the internal loop).
    const history: AgentMessage[] = compactAgentConversation(input.conversation ?? []).map(
      ({ role, content }) =>
        role === "user"
          ? { role: "user", content, timestamp: 0 }
          : {
              role: "assistant",
              content: [{ type: "text", text: content }],
              api: "wknowledge-history",
              provider: "wknowledge",
              model: "history",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
              },
              stopReason: "stop",
              timestamp: 0
            }
    );
    const loop = agentLoop(
      [{ role: "user", content: input.question, timestamp: 0 }],
      { systemPrompt: "", messages: history, tools: registry.toPiTools() },
      {
        model: LOOP_MODEL,
        toolExecution: "sequential",
        convertToLlm: (messages: AgentMessage[]) => messages as never,
        ...registry.policyHooks(input.policy)
      },
      input.signal,
      createGatewayStreamFn(recorder.gateway, {
        dataPolicy: input.dataPolicy,
        purpose: "wiki_query",
        ...(input.signal !== undefined ? { signal: input.signal } : {})
      })
    );
    for await (const event of loop as AsyncIterable<AgentEvent>) {
      for (const mapped of mapPiAgentEvent(event, input.runId)) events.push(mapped);
      if (event.type === "agent_end") {
        events.push(piTerminalAgentCoreEvent(event.messages, input.runId, input.signal));
      }
    }
  } catch (error) {
    if (input.signal?.aborted) {
      events.push({ type: "run.stopped", runId: input.runId, reason: "cancelled" });
    } else {
      const message = error instanceof Error ? error.message : undefined;
      const code = message && /^[A-Z][A-Z0-9_]*$/.test(message) ? message : "PI_AGENT_RUN_FAILED";
      events.push({ type: "run.failed", runId: input.runId, code });
    }
  }
  if (!/^run\.(completed|failed|stopped)$/.test(events.at(-1)?.type ?? "")) {
    events.push({
      type: "run.failed",
      runId: input.runId,
      code: "PI_AGENT_LOOP_ENDED_WITHOUT_TERMINAL"
    });
  }

  const modelCall = recorder.modelCall();
  const answerEligible = events.at(-1)?.type === "run.completed";
  const result = finalizeGroundedAnswer(
    answerEligible ? lastAssistantText(events) : null,
    evidence
  );
  return { events, result, modelCall };
}
