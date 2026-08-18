export type AgentCoreTerminalEvent =
  | { type: "run.completed"; runId: string }
  | { type: "run.stopped"; runId: string; reason: "cancelled" }
  | { type: "run.failed"; runId: string; code: string };

export type AgentCoreEvent =
  | { type: "run.started"; runId: string }
  | { type: "assistant.delta"; runId: string; text: string }
  | {
      type: "tool.requested";
      runId: string;
      toolCallId: string;
      tool: string;
      inputSummary: string;
    }
  | { type: "tool.completed"; runId: string; toolCallId: string; outputSummary: string }
  | AgentCoreTerminalEvent;

export type AgentCoreScriptEvent =
  | { type: "assistant.delta"; text: string }
  | { type: "tool.requested"; toolCallId: string; tool: string; inputSummary: string }
  | { type: "tool.completed"; toolCallId: string; outputSummary: string }
  | { type: "run.completed" }
  | { type: "run.failed"; code: string };

export interface AgentCoreRunInput {
  runId: string;
  script: readonly AgentCoreScriptEvent[];
  signal?: AbortSignal;
}

export interface AgentCoreAdapter {
  readonly id: string;
  run(input: AgentCoreRunInput): AsyncIterable<AgentCoreEvent>;
}

function traceError(): never {
  throw new Error("AGENT_CORE_TRACE_INVALID");
}

function validateRunId(runId: string): void {
  if (runId.trim().length === 0 || runId.length > 200) traceError();
}

function validateSummary(summary: string): void {
  if (summary.trim().length === 0 || summary.length > 2_000) traceError();
}

function validateToolName(tool: string): void {
  if (!/^[a-z][a-z0-9.-]{0,99}$/.test(tool)) traceError();
}

function validateToolCallId(toolCallId: string): void {
  if (!/^[a-z][a-z0-9_-]{0,99}$/.test(toolCallId)) traceError();
}

export class InternalAgentCoreAdapter implements AgentCoreAdapter {
  readonly id = "internal-scripted-v1";

  async *run(input: AgentCoreRunInput): AsyncIterable<AgentCoreEvent> {
    validateRunId(input.runId);
    if (input.signal?.aborted) {
      yield { type: "run.stopped", runId: input.runId, reason: "cancelled" };
      return;
    }

    yield { type: "run.started", runId: input.runId };
    for (const event of validateAgentCoreScript(input.script)) {
      if (input.signal?.aborted) {
        yield { type: "run.stopped", runId: input.runId, reason: "cancelled" };
        return;
      }
      yield { ...event, runId: input.runId };
    }
  }
}

/**
 * Shared script validator: enforces the same ordering/shape rules for every
 * AgentCoreAdapter implementation. Invalid scripts throw AGENT_CORE_TRACE_INVALID
 * instead of being silently corrected.
 */
export function validateAgentCoreScript(
  script: readonly AgentCoreScriptEvent[]
): AgentCoreScriptEvent[] {
  const requested = new Set<string>();
  const completed = new Set<string>();
  let terminal = false;
  const validated: AgentCoreScriptEvent[] = [];

  for (const event of script) {
    if (terminal) traceError();
    switch (event.type) {
      case "assistant.delta":
        validateSummary(event.text);
        break;
      case "tool.requested":
        validateToolCallId(event.toolCallId);
        validateToolName(event.tool);
        validateSummary(event.inputSummary);
        if (requested.has(event.toolCallId)) traceError();
        requested.add(event.toolCallId);
        break;
      case "tool.completed":
        validateToolCallId(event.toolCallId);
        validateSummary(event.outputSummary);
        if (!requested.has(event.toolCallId) || completed.has(event.toolCallId)) traceError();
        completed.add(event.toolCallId);
        break;
      case "run.completed":
        if (requested.size !== completed.size) traceError();
        terminal = true;
        break;
      case "run.failed":
        validateSummary(event.code);
        terminal = true;
        break;
      default:
        traceError();
    }
    validated.push(event);
  }

  if (!terminal) traceError();
  return validated;
}

export async function collectAgentCoreEvents(
  adapter: AgentCoreAdapter,
  input: AgentCoreRunInput
): Promise<AgentCoreEvent[]> {
  const events: AgentCoreEvent[] = [];
  for await (const event of adapter.run(input)) events.push(event);
  return events;
}
