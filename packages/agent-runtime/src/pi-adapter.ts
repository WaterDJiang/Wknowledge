import {
  agentLoopContinue,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  type StreamFn
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message
} from "@earendil-works/pi-ai";
import {
  validateAgentCoreScript,
  type AgentCoreAdapter,
  type AgentCoreEvent,
  type AgentCoreRunInput,
  type AgentCoreScriptEvent
} from "./agent-core";

const SYNTHETIC_API = "wknowledge-synthetic";
const SYNTHETIC_PROVIDER = "wknowledge";
const SYNTHETIC_MODEL = "scripted";

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function syntheticAssistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: SYNTHETIC_API,
    provider: SYNTHETIC_PROVIDER,
    model: SYNTHETIC_MODEL,
    usage: emptyUsage(),
    stopReason,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    timestamp: 0
  };
}

type ScriptedToolPair = {
  toolCallId: string;
  tool: string;
  inputSummary: string;
  outputSummary: string;
};

type ScriptedAssistantSegment = {
  kind: "assistant";
  deltas: string[];
  toolPairs: ScriptedToolPair[];
  errorCode?: string;
};

type ScriptedSegment = ScriptedAssistantSegment | { kind: "error"; code: string };

/**
 * Compiles a validated AgentCoreScriptEvent[] into per-turn assistant segments.
 * A segment groups consecutive text deltas with the tool calls that follow them
 * in the same assistant turn; a run.failed that directly follows text deltas is
 * merged into that segment so the failure replaces the turn's normal completion.
 */
function compileScriptSegments(script: readonly AgentCoreScriptEvent[]): ScriptedSegment[] {
  const segments: ScriptedSegment[] = [];
  let current: ScriptedAssistantSegment | null = null;
  const openAssistant = (): ScriptedAssistantSegment => {
    const segment: ScriptedAssistantSegment = { kind: "assistant", deltas: [], toolPairs: [] };
    segments.push(segment);
    return segment;
  };

  for (const event of script) {
    if (event.type === "assistant.delta") {
      let segment: ScriptedAssistantSegment = current ?? openAssistant();
      if (segment.toolPairs.length || segment.errorCode) segment = openAssistant();
      segment.deltas.push(event.text);
      current = segment;
      continue;
    }
    if (event.type === "tool.requested") {
      const segment: ScriptedAssistantSegment = current ?? openAssistant();
      current = segment;
      const pending: ScriptedToolPair = {
        toolCallId: event.toolCallId,
        tool: event.tool,
        inputSummary: event.inputSummary,
        outputSummary: ""
      };
      const index = segment.toolPairs.findIndex(
        (pair: ScriptedToolPair) => pair.toolCallId === event.toolCallId
      );
      if (index >= 0) segment.toolPairs[index] = pending;
      else segment.toolPairs.push(pending);
      continue;
    }
    if (event.type === "tool.completed") {
      const pair = current?.toolPairs.find(({ toolCallId }) => toolCallId === event.toolCallId);
      if (pair) pair.outputSummary = event.outputSummary;
      continue;
    }
    if (event.type === "run.failed") {
      if (current) current.errorCode = event.code;
      else segments.push({ kind: "error", code: event.code });
      continue;
    }
    // run.completed: the final segment ends the loop naturally (stop reason).
  }

  const last = segments.at(-1);
  if (!last) {
    // A script with no streamed content (e.g. only run.completed) still needs a
    // single empty assistant turn so the loop finishes normally.
    segments.push({ kind: "assistant", deltas: [], toolPairs: [] });
    return segments;
  }
  if (last.kind !== "assistant" || last.errorCode) return segments;
  // A turn that ends on tool calls needs one further (empty) assistant turn so
  // the loop finishes instead of requesting another scripted segment.
  if (last.toolPairs.length > 0) segments.push({ kind: "assistant", deltas: [], toolPairs: [] });
  return segments;
}

function segmentStream(segment: ScriptedSegment): ReturnType<StreamFn> {
  const stream = createAssistantMessageEventStream();
  if (segment.kind === "error") {
    queueMicrotask(() => {
      stream.push({
        type: "error",
        reason: "error",
        error: syntheticAssistantMessage([], "error", segment.code)
      });
    });
    return stream;
  }

  queueMicrotask(() => {
    const content: AssistantMessage["content"] = [];
    stream.push({
      type: "start",
      partial: syntheticAssistantMessage([], "pending")
    });
    for (const delta of segment.deltas) {
      if (content.length === 0 || content.at(-1)?.type !== "text") {
        content.push({ type: "text", text: "" });
        stream.push({
          type: "text_start",
          contentIndex: content.length - 1,
          partial: partialOf(content)
        });
      }
      stream.push({
        type: "text_delta",
        contentIndex: content.length - 1,
        delta,
        partial: partialOf(content)
      });
      (content.at(-1) as { text: string }).text += delta;
    }
    if (content.at(-1)?.type === "text") {
      const block = content.at(-1) as { type: "text"; text: string };
      stream.push({
        type: "text_end",
        contentIndex: content.length - 1,
        content: block.text,
        partial: partialOf(content)
      });
    }
    for (const pair of segment.toolPairs) {
      const contentIndex = content.length;
      const toolCall = {
        type: "toolCall" as const,
        id: pair.toolCallId,
        name: pair.tool,
        arguments: { inputSummary: pair.inputSummary }
      };
      content.push(toolCall);
      stream.push({ type: "toolcall_start", contentIndex, partial: partialOf(content) });
      stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: partialOf(content) });
    }
    if (segment.errorCode !== undefined) {
      stream.push({
        type: "error",
        reason: "error",
        error: syntheticAssistantMessage(content, "error", segment.errorCode)
      });
      return;
    }
    const reason = segment.toolPairs.length > 0 ? "toolUse" : "stop";
    stream.push({ type: "done", reason, message: syntheticAssistantMessage(content, reason) });
  });
  return stream;

  function partialOf(content: AssistantMessage["content"]): AssistantMessage {
    return syntheticAssistantMessage(
      content.map((block) => ({ ...block })),
      "pending"
    );
  }
}

type ScriptedToolParameters = {
  type: "object";
  properties: { inputSummary: { type: "string" } };
  required: ["inputSummary"];
  additionalProperties: false;
};

const SCRIPTED_TOOL_PARAMETERS: ScriptedToolParameters = {
  type: "object",
  properties: { inputSummary: { type: "string" } },
  required: ["inputSummary"],
  additionalProperties: false
};

function scriptedTools(pairs: readonly ScriptedToolPair[]): AgentTool<ScriptedToolParameters>[] {
  const byName = new Map<string, ScriptedToolPair[]>();
  for (const pair of pairs) {
    const list = byName.get(pair.tool) ?? [];
    list.push(pair);
    byName.set(pair.tool, list);
  }
  return [...byName.entries()].map(([name, calls]) => ({
    name,
    label: name,
    description: `scripted tool ${name}`,
    parameters: SCRIPTED_TOOL_PARAMETERS,
    executionMode: "sequential",
    execute: async (toolCallId: string) => {
      const pair = calls.find((candidate) => candidate.toolCallId === toolCallId);
      if (!pair) throw new Error("PI_SCRIPTED_TOOL_UNKNOWN");
      return {
        content: [{ type: "text" as const, text: pair.outputSummary }],
        details: { outputSummary: pair.outputSummary }
      };
    }
  }));
}

function stableFailureCode(message: string | undefined): string {
  return message && /^[A-Z][A-Z0-9_]*$/.test(message) ? message : "PI_AGENT_RUN_FAILED";
}

/**
 * Pi-backed AgentCoreAdapter: replays the shared script contract through the
 * real pi-agent-core loop so trajectory fixtures stay interchangeable with the
 * internal adapter. It receives only a stream function and its own tools; no
 * database, file, network or credential handles are involved.
 */
export class PiAgentCoreAdapter implements AgentCoreAdapter {
  readonly id = "pi-agent-core-0.84.2";

  async *run(input: AgentCoreRunInput): AsyncIterable<AgentCoreEvent> {
    const runId = input.runId.trim();
    if (runId.length === 0 || runId.length > 200) throw new Error("AGENT_CORE_TRACE_INVALID");
    if (input.signal?.aborted) {
      yield { type: "run.stopped", runId: input.runId, reason: "cancelled" };
      return;
    }

    const segments = compileScriptSegments(validateAgentCoreScript(input.script));
    let cursor = 0;
    const streamFn: StreamFn = () => {
      const segment = segments[cursor];
      cursor += 1;
      if (!segment) {
        const exhausted = createAssistantMessageEventStream();
        queueMicrotask(() => {
          exhausted.push({
            type: "error",
            reason: "error",
            error: syntheticAssistantMessage([], "error", "PI_SCRIPT_EXHAUSTED")
          });
        });
        return exhausted;
      }
      return segmentStream(segment);
    };

    const pairs = segments.flatMap((segment) =>
      segment.kind === "assistant" ? segment.toolPairs : []
    );
    const context: AgentContext = {
      systemPrompt: "",
      messages: [{ role: "user", content: input.runId, timestamp: 0 }],
      tools: scriptedTools(pairs)
    };
    const config: AgentLoopConfig = {
      model: {
        id: SYNTHETIC_MODEL,
        name: SYNTHETIC_MODEL,
        api: SYNTHETIC_API,
        provider: SYNTHETIC_PROVIDER,
        baseUrl: "synthetic://wknowledge",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8_192,
        maxTokens: 4_096
      },
      toolExecution: "sequential",
      convertToLlm: (messages: AgentMessage[]) => messages as unknown as Message[]
    };

    yield { type: "run.started", runId: input.runId };
    try {
      // agentLoopContinue: the context already carries the user message; the
      // agentLoop(prompts, ...) entry would append prompts to context.messages
      // again and duplicate every message for the stream function.
      for await (const event of agentLoopContinue(context, config, input.signal, streamFn)) {
        for (const mapped of mapPiAgentEvent(event, input.runId)) yield mapped;
        if (event.type === "agent_end") {
          yield piTerminalAgentCoreEvent(event.messages, input.runId, input.signal);
          return;
        }
        if (input.signal?.aborted) {
          yield { type: "run.stopped", runId: input.runId, reason: "cancelled" };
          return;
        }
      }
    } catch (error) {
      if (input.signal?.aborted) {
        yield { type: "run.stopped", runId: input.runId, reason: "cancelled" };
        return;
      }
      const message = error instanceof Error ? error.message : undefined;
      yield { type: "run.failed", runId: input.runId, code: stableFailureCode(message) };
      return;
    }
    if (input.signal?.aborted) {
      yield { type: "run.stopped", runId: input.runId, reason: "cancelled" };
      return;
    }
    yield { type: "run.failed", runId: input.runId, code: "PI_AGENT_LOOP_ENDED_WITHOUT_TERMINAL" };
  }
}

function summarize(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const outputSummary = (value as { outputSummary?: unknown }).outputSummary;
    const inputSummary = (value as { inputSummary?: unknown }).inputSummary;
    if (typeof outputSummary === "string") return outputSummary;
    if (typeof inputSummary === "string") return inputSummary;
    return JSON.stringify(value);
  }
  return "";
}

/**
 * Maps a non-terminal Pi AgentEvent to AgentCoreEvent(s) per ADR 0005. Shared
 * by the adapter and by equivalence tests so the real gateway-driven loop and
 * the scripted replay are folded through the exact same mapping.
 */
export function mapPiAgentEvent(event: AgentEvent, runId: string): AgentCoreEvent[] {
  switch (event.type) {
    case "agent_start":
      // run.started is emitted by the adapter before consuming the loop.
      return [];
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        return [{ type: "assistant.delta", runId, text: event.assistantMessageEvent.delta }];
      }
      return [];
    case "tool_execution_start":
      return [
        {
          type: "tool.requested",
          runId,
          toolCallId: event.toolCallId,
          tool: event.toolName,
          inputSummary: summarize(event.args)
        }
      ];
    case "tool_execution_end":
      return [
        {
          type: "tool.completed",
          runId,
          toolCallId: event.toolCallId,
          outputSummary: summarize((event.result as { details?: unknown } | undefined)?.details)
        }
      ];
    case "message_start":
    case "message_end":
    case "turn_start":
    case "turn_end":
    case "tool_execution_update":
    case "agent_end":
      return [];
    default:
      return [];
  }
}

/**
 * Terminal AgentCoreEvent for an agent_end: an aborted signal or Pi stop
 * reason maps to run.stopped, an error stop reason to a stable-code
 * run.failed, anything else to run.completed.
 */
export function piTerminalAgentCoreEvent(
  messages: readonly AgentMessage[],
  runId: string,
  signal?: AbortSignal
): AgentCoreEvent {
  if (signal?.aborted) return { type: "run.stopped", runId, reason: "cancelled" };
  const last = [...messages].reverse().find((message) => message?.role === "assistant");
  const stopReason = (last as AssistantMessage | undefined)?.stopReason;
  if (stopReason === "error") {
    return {
      type: "run.failed",
      runId,
      code: stableFailureCode((last as AssistantMessage | undefined)?.errorMessage)
    };
  }
  if (stopReason === "aborted") return { type: "run.stopped", runId, reason: "cancelled" };
  return { type: "run.completed", runId };
}
