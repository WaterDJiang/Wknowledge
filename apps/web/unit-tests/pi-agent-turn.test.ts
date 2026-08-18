import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentCoreEvent } from "@wknowledge/agent-runtime";
import {
  knowledgeToolCallRecords,
  piSessionPolicyBridge,
  piToolStreamEvents,
  resolveServerAgentLoop
} from "../lib/pi-agent-turn";

describe("server Agent loop selection", () => {
  it("uses Pi by default and allows internal only as an explicit incident rollback", () => {
    expect(resolveServerAgentLoop(undefined)).toBe("pi");
    expect(resolveServerAgentLoop("pi")).toBe("pi");
    expect(resolveServerAgentLoop("anything-else")).toBe("pi");
    expect(resolveServerAgentLoop("internal")).toBe("internal");
  });

  it("keeps the server Web route independent of local SQLite adapters", async () => {
    const root = process.cwd();
    const route = await readFile(
      path.join(
        root,
        "apps",
        "web",
        "app",
        "api",
        "agent-sessions",
        "[sessionId]",
        "runs",
        "route.ts"
      ),
      "utf8"
    );

    expect(route).toContain("resolveServerAgentLoop");
    expect(route).not.toContain("node:sqlite");
    expect(route).not.toContain("createSqlite");
    expect(route).not.toContain("WKNOWLEDGE_DATABASE_PROFILE");
  });
});

function eventStream(runId: string, readCount: number): AgentCoreEvent[] {
  return [
    { type: "run.started", runId },
    {
      type: "tool.requested",
      runId,
      toolCallId: "call-search",
      tool: "knowledge.search",
      inputSummary: "{}"
    },
    {
      type: "tool.completed",
      runId,
      toolCallId: "call-search",
      outputSummary: '{"resultCount":3,"searchedPages":5}'
    },
    {
      type: "tool.requested",
      runId,
      toolCallId: "call-read",
      tool: "knowledge.read",
      inputSummary: `{"evidenceIds":${JSON.stringify(Array.from({ length: readCount }, (_, i) => `e-${i}`))}}`
    },
    {
      type: "tool.completed",
      runId,
      toolCallId: "call-read",
      outputSummary: `{"resultCount":${readCount}}`
    },
    { type: "assistant.delta", runId, text: "回答" },
    { type: "run.completed", runId }
  ];
}

describe("piSessionPolicyBridge", () => {
  it("allows tool calls while the session stays readable", async () => {
    const assertReadable = vi.fn(async () => undefined);
    const bridge = piSessionPolicyBridge({ assertReadable });
    expect(await bridge.beforeToolCall({ tool: {} as never, args: {} })).toEqual({
      allow: true
    });
    expect(assertReadable).toHaveBeenCalledOnce();
    expect(
      await bridge.afterToolCall({
        tool: {} as never,
        args: {},
        result: { content: [], isError: false }
      })
    ).toEqual({});
  });

  it("denies with the original stable code and terminates on revocation", async () => {
    const bridge = piSessionPolicyBridge({
      assertReadable: async () => {
        throw new Error("AGENT_SESSION_ACCESS_REVOKED");
      }
    });
    expect(await bridge.beforeToolCall({ tool: {} as never, args: {} })).toEqual({
      allow: false,
      code: "AGENT_SESSION_ACCESS_REVOKED",
      terminate: true
    });
  });

  it("normalizes a non-code revocation failure", async () => {
    const bridge = piSessionPolicyBridge({
      assertReadable: async () => {
        throw new Error("database exploded");
      }
    });
    expect(await bridge.beforeToolCall({ tool: {} as never, args: {} })).toEqual({
      allow: false,
      code: "AGENT_SESSION_ACCESS_REVOKED",
      terminate: true
    });
  });
});

describe("knowledgeToolCallRecords", () => {
  it("derives search and read records from the event stream", () => {
    const records = knowledgeToolCallRecords(eventStream("run-1", 2), {
      searchedPages: 5,
      evidenceCount: 3,
      bindingCount: 2
    });
    expect(records).toEqual([
      {
        name: "knowledge.search",
        inputSummary: "在 2 个受管知识范围中检索",
        outputSummary: "检索 5 页，得到 3 条候选",
        resultCount: 3,
        searchedPages: 5
      },
      {
        name: "knowledge.read",
        inputSummary: "读取 2 个已检索证据片段",
        outputSummary: "读取 2 个已检索证据片段",
        resultCount: 2,
        searchedPages: 2
      }
    ]);
  });

  it("falls back to the evidence count when read args are unreadable", () => {
    const events = eventStream("run-1", 2).map((event) =>
      event.type === "tool.requested" && event.tool === "knowledge.read"
        ? { ...event, inputSummary: "{bad json" }
        : event
    );
    const records = knowledgeToolCallRecords(events, {
      searchedPages: 5,
      evidenceCount: 3,
      bindingCount: 1
    });
    expect(records[1]).toMatchObject({ name: "knowledge.read", resultCount: 3 });
  });
});

describe("piToolStreamEvents", () => {
  it("maps tool events in order with pairing by call id", () => {
    const events = piToolStreamEvents(eventStream("run-1", 2), "run-1", {
      searchedPages: 5,
      evidenceCount: 3
    });
    expect(events).toEqual([
      {
        type: "tool.requested",
        runId: "run-1",
        tool: "knowledge.search",
        inputSummary: "在已绑定知识空间中检索"
      },
      {
        type: "tool.completed",
        runId: "run-1",
        tool: "knowledge.search",
        outputSummary: "已检索 5 页，得到 3 条候选"
      },
      {
        type: "tool.requested",
        runId: "run-1",
        tool: "knowledge.read",
        inputSummary: "读取已检索的受管证据片段"
      },
      {
        type: "tool.completed",
        runId: "run-1",
        tool: "knowledge.read",
        outputSummary: "已读取 2 条受管证据片段"
      }
    ]);
  });

  it("emits nothing for streams without tool events", () => {
    expect(
      piToolStreamEvents(
        [
          { type: "run.started", runId: "r" },
          { type: "run.completed", runId: "r" }
        ],
        "r",
        { searchedPages: 0, evidenceCount: 0 }
      )
    ).toEqual([]);
  });
});
