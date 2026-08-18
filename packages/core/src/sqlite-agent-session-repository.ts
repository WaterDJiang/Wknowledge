import type {
  AgentSessionRepository,
  RepositoryRunEvent,
  RepositorySessionMessage
} from "./agent-session-repository-port";

/**
 * SQLite-backed Pi session repository (local runtime profile, spec §7.1) on
 * the built-in node:sqlite module. Same availability gating as the SQLite
 * job queue: dynamic import, SQLITE_RUNTIME_UNAVAILABLE fail-closed.
 */

interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS agent_session (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_session(id) ON DELETE cascade,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_run (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_session(id) ON DELETE cascade,
  user_message_id TEXT NOT NULL REFERENCES agent_message(id),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'stopped')),
  error_code TEXT
);
CREATE TABLE IF NOT EXISTS agent_run_event (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_run(id) ON DELETE cascade,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  tool TEXT,
  input_summary TEXT,
  output_summary TEXT,
  status TEXT NOT NULL,
  UNIQUE (run_id, sequence)
);
`;

function repoError(code: string): never {
  throw new Error(code);
}

const MAX_SUMMARY_LENGTH = 300;

function assertEventInput(input: Parameters<AgentSessionRepository["appendRunEvent"]>[0]): void {
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

export async function createSqliteAgentSessionRepository(input?: {
  databasePath?: string;
}): Promise<AgentSessionRepository> {
  const sqlite = await import("node:sqlite").catch(() => {
    throw new Error("SQLITE_RUNTIME_UNAVAILABLE");
  });
  const database = new (
    sqlite as unknown as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    }
  ).DatabaseSync(input?.databasePath ?? ":memory:") as SqliteDatabase;
  database.exec(CREATE_TABLES);
  let sequence = 0;

  const sessionById = database.prepare("SELECT * FROM agent_session WHERE id = ?");
  const insertSession = database.prepare(
    "INSERT INTO agent_session (id, owner_id, title, created_at) VALUES (?, ?, ?, ?)"
  );
  const insertMessage = database.prepare(
    "INSERT INTO agent_message (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  const messagesBySession = database.prepare(
    "SELECT * FROM agent_message WHERE session_id = ? ORDER BY id"
  );
  const runById = database.prepare("SELECT * FROM agent_run WHERE id = ?");
  const insertRun = database.prepare(
    "INSERT INTO agent_run (id, session_id, user_message_id, status, error_code) VALUES (?, ?, ?, 'running', NULL)"
  );
  const insertEvent = database.prepare(
    `INSERT INTO agent_run_event (id, run_id, sequence, type, tool, input_summary, output_summary, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const eventsByRun = database.prepare(
    "SELECT * FROM agent_run_event WHERE run_id = ? ORDER BY sequence"
  );
  const settleStatement = database.prepare(
    "UPDATE agent_run SET status = ?, error_code = ? WHERE id = ?"
  );
  const eventCount = database.prepare(
    "SELECT COUNT(*) AS total FROM agent_run_event WHERE run_id = ?"
  );

  function nextId(prefix: string): string {
    sequence += 1;
    return `${prefix}-${sequence.toString().padStart(8, "0")}`;
  }

  function messageRow(row: Record<string, unknown>): RepositorySessionMessage {
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      role: String(row.role) as RepositorySessionMessage["role"],
      content: String(row.content),
      createdAt: String(row.created_at)
    };
  }

  function eventRow(row: Record<string, unknown>): RepositoryRunEvent {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      sequence: Number(row.sequence),
      type: String(row.type) as RepositoryRunEvent["type"],
      tool: row.tool === null ? null : String(row.tool),
      inputSummary: row.input_summary === null ? null : String(row.input_summary),
      outputSummary: row.output_summary === null ? null : String(row.output_summary),
      status: String(row.status) as RepositoryRunEvent["status"]
    };
  }

  return {
    async createSession(sessionInput) {
      if (sessionInput.ownerId.trim().length === 0 || sessionInput.title.trim().length === 0) {
        repoError("AGENT_REPOSITORY_SESSION_INVALID");
      }
      const id = nextId("session");
      insertSession.run(id, sessionInput.ownerId, sessionInput.title, new Date().toISOString());
      return { id };
    },

    async appendMessage(messageInput) {
      if (!sessionById.get(messageInput.sessionId)) {
        repoError("AGENT_REPOSITORY_SESSION_NOT_FOUND");
      }
      if (messageInput.content.trim().length === 0) {
        repoError("AGENT_REPOSITORY_MESSAGE_INVALID");
      }
      const id = nextId("message");
      const stamp = new Date().toISOString();
      insertMessage.run(id, messageInput.sessionId, messageInput.role, messageInput.content, stamp);
      return {
        id,
        sessionId: messageInput.sessionId,
        role: messageInput.role,
        content: messageInput.content,
        createdAt: stamp
      };
    },

    async beginRun(runInput) {
      if (!sessionById.get(runInput.sessionId)) {
        repoError("AGENT_REPOSITORY_SESSION_NOT_FOUND");
      }
      const id = nextId("run");
      insertRun.run(id, runInput.sessionId, runInput.userMessageId);
      return { id };
    },

    async appendRunEvent(eventInput) {
      const run = runById.get(eventInput.runId) as Record<string, unknown> | undefined;
      if (!run) repoError("AGENT_REPOSITORY_RUN_NOT_FOUND");
      if (run.status !== "running") repoError("AGENT_REPOSITORY_RUN_SETTLED");
      assertEventInput(eventInput);
      const total = eventCount.get(eventInput.runId) as { total: number };
      const id = nextId("event");
      const event: RepositoryRunEvent = {
        id,
        runId: eventInput.runId,
        sequence: Number(total.total) + 1,
        type: eventInput.type,
        tool: eventInput.tool ?? null,
        inputSummary: eventInput.inputSummary ?? null,
        outputSummary: eventInput.outputSummary ?? null,
        status: eventInput.status ?? "running"
      };
      insertEvent.run(
        event.id,
        event.runId,
        event.sequence,
        event.type,
        event.tool,
        event.inputSummary,
        event.outputSummary,
        event.status
      );
      return event;
    },

    async settleRun(settleInput) {
      const run = runById.get(settleInput.runId) as Record<string, unknown> | undefined;
      if (!run) repoError("AGENT_REPOSITORY_RUN_NOT_FOUND");
      if (run.status !== "running") repoError("AGENT_REPOSITORY_RUN_SETTLED");
      if (settleInput.errorCode !== undefined && settleInput.errorCode.trim().length === 0) {
        repoError("AGENT_REPOSITORY_RUN_INVALID");
      }
      settleStatement.run(settleInput.status, settleInput.errorCode ?? null, settleInput.runId);
    },

    async listRunEvents(runId) {
      return (eventsByRun.all(runId) as Array<Record<string, unknown>>).map(eventRow);
    },

    async listSessionMessages(sessionId) {
      return (messagesBySession.all(sessionId) as Array<Record<string, unknown>>).map(messageRow);
    }
  };
}
