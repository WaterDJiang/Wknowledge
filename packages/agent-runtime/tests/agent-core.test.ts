import { describe, expect, it } from "vitest";
import {
  collectAgentCoreEvents,
  InternalAgentCoreAdapter,
  type AgentCoreScriptEvent
} from "../src/index";

const adapter = new InternalAgentCoreAdapter();

async function events(script: readonly AgentCoreScriptEvent[], signal?: AbortSignal) {
  return collectAgentCoreEvents(adapter, { runId: "run-fixture", script, signal });
}

describe("internal agent core adapter", () => {
  it.each([
    {
      name: "emits a single answer",
      script: [{ type: "assistant.delta", text: "answer" }, { type: "run.completed" }]
    },
    {
      name: "emits a serial tool trace",
      script: [
        {
          type: "tool.requested",
          toolCallId: "search-1",
          tool: "knowledge.search",
          inputSummary: "query"
        },
        { type: "tool.completed", toolCallId: "search-1", outputSummary: "1 result" },
        { type: "assistant.delta", text: "grounded answer" },
        { type: "run.completed" }
      ]
    },
    {
      name: "emits multiple completed tools",
      script: [
        {
          type: "tool.requested",
          toolCallId: "list-1",
          tool: "knowledge.list",
          inputSummary: "scope"
        },
        { type: "tool.completed", toolCallId: "list-1", outputSummary: "1 path" },
        {
          type: "tool.requested",
          toolCallId: "read-1",
          tool: "knowledge.read",
          inputSummary: "page"
        },
        { type: "tool.completed", toolCallId: "read-1", outputSummary: "excerpt" },
        { type: "run.completed" }
      ]
    },
    {
      name: "emits a failed terminal event",
      script: [{ type: "run.failed", code: "MODEL_TIMEOUT" }]
    }
  ])("$name", async ({ script }) => {
    const result = await events(script);
    expect(result[0]).toEqual({ type: "run.started", runId: "run-fixture" });
    expect(result.at(-1)?.type).toMatch(/^run\.(completed|failed)$/);
    expect(result.every((event) => event.runId === "run-fixture")).toBe(true);
  });

  it.each([
    {
      name: "rejects a completion before its request",
      script: [
        { type: "tool.completed", toolCallId: "search-1", outputSummary: "result" },
        { type: "run.completed" }
      ]
    },
    {
      name: "rejects duplicate tool requests",
      script: [
        {
          type: "tool.requested",
          toolCallId: "search-1",
          tool: "knowledge.search",
          inputSummary: "query"
        },
        {
          type: "tool.requested",
          toolCallId: "search-1",
          tool: "knowledge.search",
          inputSummary: "query"
        },
        { type: "run.completed" }
      ]
    },
    {
      name: "rejects duplicate tool completions",
      script: [
        {
          type: "tool.requested",
          toolCallId: "search-1",
          tool: "knowledge.search",
          inputSummary: "query"
        },
        { type: "tool.completed", toolCallId: "search-1", outputSummary: "result" },
        { type: "tool.completed", toolCallId: "search-1", outputSummary: "result" },
        { type: "run.completed" }
      ]
    },
    {
      name: "rejects an unfinished tool at completion",
      script: [
        {
          type: "tool.requested",
          toolCallId: "search-1",
          tool: "knowledge.search",
          inputSummary: "query"
        },
        { type: "run.completed" }
      ]
    },
    {
      name: "rejects an event after completion",
      script: [{ type: "run.completed" }, { type: "assistant.delta", text: "late" }]
    },
    {
      name: "rejects a missing terminal event",
      script: [{ type: "assistant.delta", text: "unfinished" }]
    },
    {
      name: "rejects an empty delta",
      script: [{ type: "assistant.delta", text: " " }, { type: "run.completed" }]
    },
    {
      name: "rejects an invalid tool name",
      script: [
        { type: "tool.requested", toolCallId: "search-1", tool: "Shell", inputSummary: "query" },
        { type: "tool.completed", toolCallId: "search-1", outputSummary: "result" },
        { type: "run.completed" }
      ]
    },
    {
      name: "rejects an invalid tool call id",
      script: [
        {
          type: "tool.requested",
          toolCallId: "Search 1",
          tool: "knowledge.search",
          inputSummary: "query"
        },
        { type: "tool.completed", toolCallId: "Search 1", outputSummary: "result" },
        { type: "run.completed" }
      ]
    },
    { name: "rejects an empty failure code", script: [{ type: "run.failed", code: "" }] },
    {
      name: "rejects a forged runtime event",
      script: [{ type: "run.started" } as never, { type: "run.completed" }]
    },
    {
      name: "rejects a terminal followed by tool output",
      script: [
        { type: "run.failed", code: "MODEL_TIMEOUT" },
        { type: "tool.completed", toolCallId: "search-1", outputSummary: "result" }
      ]
    }
  ])("$name", async ({ script }) => {
    await expect(events(script)).rejects.toThrow("AGENT_CORE_TRACE_INVALID");
  });

  it("stops immediately when the signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(events([{ type: "run.completed" }], controller.signal)).resolves.toEqual([
      { type: "run.stopped", runId: "run-fixture", reason: "cancelled" }
    ]);
  });

  it("stops before a later scripted event when cancellation occurs", async () => {
    const controller = new AbortController();
    const stream = adapter.run({
      runId: "run-fixture",
      signal: controller.signal,
      script: [
        { type: "assistant.delta", text: "first" },
        { type: "assistant.delta", text: "must not emit" },
        { type: "run.completed" }
      ]
    });
    const iterator = stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: { type: "run.started" } });
    controller.abort();
    expect(await iterator.next()).toEqual({
      value: { type: "run.stopped", runId: "run-fixture", reason: "cancelled" },
      done: false
    });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it.each(["", " "])("rejects an invalid run id %j", async (runId) => {
    await expect(
      collectAgentCoreEvents(adapter, { runId, script: [{ type: "run.completed" }] })
    ).rejects.toThrow("AGENT_CORE_TRACE_INVALID");
  });
});
