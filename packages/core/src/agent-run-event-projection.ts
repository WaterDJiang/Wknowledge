import { and, asc, eq } from "drizzle-orm";
import { getDatabase, schema } from "@wknowledge/database";
import type { AgentCoreEvent } from "@wknowledge/agent-runtime";

/**
 * Pi run-event projection (M5-16, ADR 0005 §2): folds an AgentCoreEvent
 * stream into the persisted agent_run_event rows that SSE replay reads.
 * Streaming text deltas are deliberately not persisted; tool events keep
 * only sanitized summaries; the run settles exactly once to its terminal
 * status. Anything malformed fails closed without partial writes.
 */

const PERSISTED_TOOLS = new Set(["knowledge.search", "knowledge.read"]);
const MAX_SUMMARY_LENGTH = 300; // agent_run_event_summary_size_check

export interface AgentEventProjectionOutcome {
  persisted: number;
  terminal: "run.completed" | "run.failed" | "run.stopped";
  errorCode: string | null;
}

function projectionError(code: string): never {
  throw new Error(code);
}

function assertSummary(value: string): void {
  if (value.trim().length === 0 || value.length > MAX_SUMMARY_LENGTH) {
    projectionError("AGENT_RUN_PROJECTION_INVALID");
  }
}

export async function persistAgentCoreEventProjection(input: {
  runId: string;
  events: readonly AgentCoreEvent[];
}): Promise<AgentEventProjectionOutcome> {
  if (input.events.length === 0) projectionError("AGENT_RUN_PROJECTION_INVALID");
  if (input.events[0]?.type !== "run.started") projectionError("AGENT_RUN_PROJECTION_INVALID");

  const requested = new Set<string>();
  const completed = new Set<string>();
  const toolByCallId = new Map<string, string>();
  let terminal: AgentCoreEvent | null = null;
  for (const event of input.events) {
    if (event.runId !== input.runId) projectionError("AGENT_RUN_PROJECTION_INVALID");
    if (terminal) projectionError("AGENT_RUN_PROJECTION_INVALID");
    switch (event.type) {
      case "run.started":
        if (requested.size || completed.size) projectionError("AGENT_RUN_PROJECTION_INVALID");
        break;
      case "assistant.delta":
        break;
      case "tool.requested": {
        if (!PERSISTED_TOOLS.has(event.tool)) projectionError("AGENT_RUN_PROJECTION_INVALID");
        if (requested.has(event.toolCallId)) projectionError("AGENT_RUN_PROJECTION_INVALID");
        assertSummary(event.inputSummary);
        requested.add(event.toolCallId);
        toolByCallId.set(event.toolCallId, event.tool);
        break;
      }
      case "tool.completed": {
        if (!requested.has(event.toolCallId) || completed.has(event.toolCallId)) {
          projectionError("AGENT_RUN_PROJECTION_INVALID");
        }
        assertSummary(event.outputSummary);
        completed.add(event.toolCallId);
        break;
      }
      case "run.failed":
        if (event.code.trim().length === 0 || event.code.length > 200) {
          projectionError("AGENT_RUN_PROJECTION_INVALID");
        }
        terminal = event;
        break;
      case "run.completed":
      case "run.stopped":
        terminal = event;
        break;
      default:
        projectionError("AGENT_RUN_PROJECTION_INVALID");
    }
  }
  if (!terminal) projectionError("AGENT_RUN_PROJECTION_INVALID");
  if (requested.size !== completed.size) projectionError("AGENT_RUN_PROJECTION_INVALID");

  const terminalEvent = terminal as Extract<
    AgentCoreEvent,
    { type: "run.completed" | "run.failed" | "run.stopped" }
  >;
  const errorCode = terminalEvent.type === "run.failed" ? terminalEvent.code : null;

  const db = getDatabase();
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ id: schema.agentRuns.id, status: schema.agentRuns.status })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, input.runId))
      .for("update")
      .limit(1);
    if (!run) projectionError("AGENT_RUN_NOT_FOUND");
    if (run.status !== "running") projectionError("AGENT_RUN_ALREADY_SETTLED");

    const existingEvents = await tx
      .select({ sequence: schema.agentRunEvents.sequence, type: schema.agentRunEvents.type })
      .from(schema.agentRunEvents)
      .where(eq(schema.agentRunEvents.agentRunId, input.runId))
      .orderBy(asc(schema.agentRunEvents.sequence));
    const hasStarted = existingEvents.some((event) => event.type === "run.started");
    if (existingEvents.some((event) => event.type !== "run.started")) {
      projectionError("AGENT_RUN_ALREADY_PROJECTED");
    }

    let sequence = existingEvents.at(-1)?.sequence ?? 0;
    let persisted = 0;
    for (const event of input.events) {
      if (event.type === "assistant.delta") continue;
      // beginAgentSessionRun already persisted run.started at sequence 1.
      if (event.type === "run.started" && hasStarted) continue;
      sequence += 1;
      if (event.type === "run.started") {
        await tx.insert(schema.agentRunEvents).values({
          agentRunId: input.runId,
          sequence,
          type: "run.started",
          status: "running"
        });
      } else if (event.type === "tool.requested") {
        await tx.insert(schema.agentRunEvents).values({
          agentRunId: input.runId,
          sequence,
          type: "tool.requested",
          tool: event.tool as "knowledge.search" | "knowledge.read",
          inputSummary: event.inputSummary
        });
      } else if (event.type === "tool.completed") {
        await tx.insert(schema.agentRunEvents).values({
          agentRunId: input.runId,
          sequence,
          type: "tool.completed",
          tool: (toolByCallId.get(event.toolCallId) ?? null) as
            "knowledge.search" | "knowledge.read" | null,
          outputSummary: event.outputSummary
        });
      } else if (event.type === "run.completed") {
        await tx.insert(schema.agentRunEvents).values({
          agentRunId: input.runId,
          sequence,
          type: "run.completed",
          status: "completed"
        });
      } else if (event.type === "run.failed") {
        await tx.insert(schema.agentRunEvents).values({
          agentRunId: input.runId,
          sequence,
          type: "run.failed",
          status: "failed"
        });
      } else {
        await tx.insert(schema.agentRunEvents).values({
          agentRunId: input.runId,
          sequence,
          type: "run.stopped",
          status: "stopped"
        });
      }
      persisted += 1;
    }

    await tx
      .update(schema.agentRuns)
      .set({
        status:
          terminalEvent.type === "run.completed"
            ? "completed"
            : terminalEvent.type === "run.failed"
              ? "failed"
              : "stopped",
        ...(errorCode !== null ? { errorCode } : {}),
        completedAt: new Date()
      })
      .where(and(eq(schema.agentRuns.id, input.runId)));

    return { persisted, terminal: terminalEvent.type, errorCode };
  });
}
