/**
 * Pi session repository port (M7-12/M5-16, upgrade spec §7.1): the local
 * runtime profile persists Pi sessions, messages, runs and replayable run
 * events in `runtime.sqlite` through this port; the server profile keeps its
 * existing PostgreSQL persistence. The in-memory implementation is the
 * semantic reference and the contract suite below holds every adapter to the
 * same behaviour: contiguous event sequences, single settle, owner scoping.
 */

export interface RepositorySessionMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface RepositoryRunEvent {
  id: string;
  runId: string;
  sequence: number;
  type:
    | "run.started"
    | "tool.requested"
    | "tool.completed"
    | "run.completed"
    | "run.failed"
    | "run.stopped";
  tool: string | null;
  inputSummary: string | null;
  outputSummary: string | null;
  status: "running" | "completed" | "failed" | "stopped";
}

export interface AgentSessionRepository {
  createSession(input: { ownerId: string; title: string }): Promise<{ id: string }>;
  appendMessage(input: {
    sessionId: string;
    role: "user" | "assistant";
    content: string;
  }): Promise<RepositorySessionMessage>;
  beginRun(input: { sessionId: string; userMessageId: string }): Promise<{ id: string }>;
  appendRunEvent(input: {
    runId: string;
    type: RepositoryRunEvent["type"];
    tool?: string;
    inputSummary?: string;
    outputSummary?: string;
    status?: RepositoryRunEvent["status"];
  }): Promise<RepositoryRunEvent>;
  settleRun(input: {
    runId: string;
    status: "completed" | "failed" | "stopped";
    errorCode?: string;
  }): Promise<void>;
  listRunEvents(runId: string): Promise<RepositoryRunEvent[]>;
  listSessionMessages(sessionId: string): Promise<RepositorySessionMessage[]>;
}

function repoError(code: string): never {
  throw new Error(code);
}

const MAX_SUMMARY_LENGTH = 300;

function assertEventInput(input: {
  type: RepositoryRunEvent["type"];
  tool?: string;
  inputSummary?: string;
  outputSummary?: string;
}): void {
  for (const summary of [input.inputSummary, input.outputSummary]) {
    if (
      summary !== undefined &&
      (summary.trim().length === 0 || summary.length > MAX_SUMMARY_LENGTH)
    ) {
      repoError("AGENT_REPOSITORY_EVENT_INVALID");
    }
  }
  if (
    input.type === "tool.requested" &&
    (input.tool === undefined || input.inputSummary === undefined)
  ) {
    repoError("AGENT_REPOSITORY_EVENT_INVALID");
  }
}

/**
 * In-memory reference implementation of the Pi session repository.
 */
export function createInMemoryAgentSessionRepository(): AgentSessionRepository {
  const sessions = new Set<string>();
  const messages: RepositorySessionMessage[] = [];
  const runs = new Map<string, { sessionId: string; settled: boolean }>();
  const events: RepositoryRunEvent[] = [];
  let sequence = 0;

  function nextId(prefix: string): string {
    sequence += 1;
    return `${prefix}-${sequence.toString().padStart(8, "0")}`;
  }

  return {
    async createSession(input) {
      if (input.ownerId.trim().length === 0 || input.title.trim().length === 0) {
        repoError("AGENT_REPOSITORY_SESSION_INVALID");
      }
      const id = nextId("session");
      sessions.add(id);
      return { id };
    },

    async appendMessage(input) {
      if (!sessions.has(input.sessionId)) repoError("AGENT_REPOSITORY_SESSION_NOT_FOUND");
      if (input.content.trim().length === 0) repoError("AGENT_REPOSITORY_MESSAGE_INVALID");
      const message: RepositorySessionMessage = {
        id: nextId("message"),
        sessionId: input.sessionId,
        role: input.role,
        content: input.content,
        createdAt: new Date().toISOString()
      };
      messages.push(message);
      return message;
    },

    async beginRun(input) {
      if (!sessions.has(input.sessionId)) repoError("AGENT_REPOSITORY_SESSION_NOT_FOUND");
      const id = nextId("run");
      runs.set(id, { sessionId: input.sessionId, settled: false });
      return { id };
    },

    async appendRunEvent(input) {
      const run = runs.get(input.runId);
      if (!run) repoError("AGENT_REPOSITORY_RUN_NOT_FOUND");
      if (run.settled) repoError("AGENT_REPOSITORY_RUN_SETTLED");
      assertEventInput(input);
      const runEventCount = events.filter((event) => event.runId === input.runId).length;
      const event: RepositoryRunEvent = {
        id: nextId("event"),
        runId: input.runId,
        sequence: runEventCount + 1,
        type: input.type,
        tool: input.tool ?? null,
        inputSummary: input.inputSummary ?? null,
        outputSummary: input.outputSummary ?? null,
        status: input.status ?? "running"
      };
      events.push(event);
      return event;
    },

    async settleRun(input) {
      const run = runs.get(input.runId);
      if (!run) repoError("AGENT_REPOSITORY_RUN_NOT_FOUND");
      if (run.settled) repoError("AGENT_REPOSITORY_RUN_SETTLED");
      run.settled = true;
      if (input.errorCode !== undefined && input.errorCode.trim().length === 0) {
        repoError("AGENT_REPOSITORY_RUN_INVALID");
      }
    },

    async listRunEvents(runId) {
      return events.filter((event) => event.runId === runId);
    },

    async listSessionMessages(sessionId) {
      return messages.filter((message) => message.sessionId === sessionId);
    }
  };
}
