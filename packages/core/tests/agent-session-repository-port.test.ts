import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  createInMemoryAgentSessionRepository,
  type AgentSessionRepository
} from "../src/agent-session-repository-port";
import { createSqliteAgentSessionRepository } from "../src/sqlite-agent-session-repository";

const SQLITE_AVAILABLE = (() => {
  try {
    createRequire(import.meta.url)("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

/**
 * The repository contract both implementations must satisfy: session/message
 * lifecycle, contiguous replayable event sequences and single settlement.
 */
const scenarios: Array<{ name: string; run(repo: AgentSessionRepository): Promise<void> }> = [
  {
    name: "stores a session conversation in order",
    async run(repo) {
      const session = await repo.createSession({ ownerId: "owner-1", title: "本地会话" });
      const user = await repo.appendMessage({
        sessionId: session.id,
        role: "user",
        content: "间隔检索怎么做？"
      });
      const assistant = await repo.appendMessage({
        sessionId: session.id,
        role: "assistant",
        content: "应每天练习。"
      });
      const messages = await repo.listSessionMessages(session.id);
      expect(messages.map(({ role }) => role)).toEqual(["user", "assistant"]);
      expect(messages[1]?.id).toBe(assistant.id);
      void user;
    }
  },
  {
    name: "persists contiguous replayable run events",
    async run(repo) {
      const session = await repo.createSession({ ownerId: "owner-1", title: "运行" });
      const user = await repo.appendMessage({ sessionId: session.id, role: "user", content: "q" });
      const run = await repo.beginRun({ sessionId: session.id, userMessageId: user.id });
      await repo.appendRunEvent({ runId: run.id, type: "run.started", status: "running" });
      await repo.appendRunEvent({
        runId: run.id,
        type: "tool.requested",
        tool: "knowledge.search",
        inputSummary: "检索"
      });
      await repo.appendRunEvent({
        runId: run.id,
        type: "tool.completed",
        tool: "knowledge.search",
        outputSummary: "2 条"
      });
      await repo.appendRunEvent({ runId: run.id, type: "run.completed", status: "completed" });
      const events = await repo.listRunEvents(run.id);
      expect(events.map(({ type }) => type)).toEqual([
        "run.started",
        "tool.requested",
        "tool.completed",
        "run.completed"
      ]);
      expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
    }
  },
  {
    name: "settles each run exactly once",
    async run(repo) {
      const session = await repo.createSession({ ownerId: "owner-1", title: "终态" });
      const user = await repo.appendMessage({ sessionId: session.id, role: "user", content: "q" });
      const run = await repo.beginRun({ sessionId: session.id, userMessageId: user.id });
      await repo.appendRunEvent({ runId: run.id, type: "run.started" });
      await repo.settleRun({ runId: run.id, status: "failed", errorCode: "MODEL_TIMEOUT" });
      await expect(repo.appendRunEvent({ runId: run.id, type: "run.completed" })).rejects.toThrow(
        "AGENT_REPOSITORY_RUN_SETTLED"
      );
      await expect(repo.settleRun({ runId: run.id, status: "completed" })).rejects.toThrow(
        "AGENT_REPOSITORY_RUN_SETTLED"
      );
    }
  },
  {
    name: "rejects malformed shapes fail-closed",
    async run(repo) {
      await expect(repo.createSession({ ownerId: " ", title: "t" })).rejects.toThrow(
        "AGENT_REPOSITORY_SESSION_INVALID"
      );
      const session = await repo.createSession({ ownerId: "o", title: "t" });
      await expect(
        repo.appendMessage({ sessionId: "missing", role: "user", content: "q" })
      ).rejects.toThrow("AGENT_REPOSITORY_SESSION_NOT_FOUND");
      await expect(
        repo.appendMessage({ sessionId: session.id, role: "user", content: " " })
      ).rejects.toThrow("AGENT_REPOSITORY_MESSAGE_INVALID");
      const user = await repo.appendMessage({ sessionId: session.id, role: "user", content: "q" });
      const run = await repo.beginRun({ sessionId: session.id, userMessageId: user.id });
      await expect(
        repo.appendRunEvent({ runId: run.id, type: "tool.requested", tool: "knowledge.search" })
      ).rejects.toThrow("AGENT_REPOSITORY_EVENT_INVALID");
      await expect(repo.appendRunEvent({ runId: "missing", type: "run.started" })).rejects.toThrow(
        "AGENT_REPOSITORY_RUN_NOT_FOUND"
      );
    }
  }
];

describe("agent session repository contract (in-memory reference)", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await scenario.run(createInMemoryAgentSessionRepository());
    });
  }
});

describe("agent session repository contract (sqlite local profile)", () => {
  const sqliteTest = SQLITE_AVAILABLE ? it : it.skip;
  for (const scenario of scenarios) {
    sqliteTest(scenario.name, async () => {
      await scenario.run(await createSqliteAgentSessionRepository());
    });
  }
  SQLITE_TEST_PERSISTENCE();
});

function SQLITE_TEST_PERSISTENCE() {
  const sqliteTest = SQLITE_AVAILABLE ? it : it.skip;
  sqliteTest("persists across repository reopenings on a file database", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const directory = await mkdtemp(path.join(tmpdir(), "wknowledge-runtime-sqlite-"));
    try {
      const databasePath = path.join(directory, "runtime.sqlite");
      const first = await createSqliteAgentSessionRepository({ databasePath });
      const session = await first.createSession({ ownerId: "owner", title: "持久会话" });
      await first.appendMessage({ sessionId: session.id, role: "user", content: "问题" });
      const second = await createSqliteAgentSessionRepository({ databasePath });
      const messages = await second.listSessionMessages(session.id);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toBe("问题");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
