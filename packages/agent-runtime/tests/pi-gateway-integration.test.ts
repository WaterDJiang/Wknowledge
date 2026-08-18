import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  agentLoop,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentTool
} from "@earendil-works/pi-agent-core";
import type { ModelGateway, ModelRequest, ModelResponse } from "@wknowledge/model-gateway";
import {
  collectAgentCoreEvents,
  createGatewayStreamFn,
  mapPiAgentEvent,
  PiAgentCoreAdapter,
  piTerminalAgentCoreEvent,
  type AgentCoreEvent,
  type AgentCoreScriptEvent
} from "../src/index";

type SearchParameters = { type: "object"; properties: { query: { type: "string" } } };
const SEARCH_PARAMETERS: SearchParameters = {
  type: "object",
  properties: { query: { type: "string" } }
};

type ReadParameters = {
  type: "object";
  properties: { evidenceIds: { type: "array"; items: { type: "string" } } };
  required: ["evidenceIds"];
};
const READ_PARAMETERS: ReadParameters = {
  type: "object",
  properties: { evidenceIds: { type: "array", items: { type: "string" } } },
  required: ["evidenceIds"]
};

const evidenceItems = [
  { id: "e1", pageId: "page-1", text: "证据一" },
  { id: "e2", pageId: "page-2", text: "证据二" }
];

function knowledgeSearchTool(): AgentTool<SearchParameters> {
  return {
    name: "knowledge.search",
    label: "knowledge.search",
    description: "检索当前已授权知识范围",
    parameters: SEARCH_PARAMETERS,
    executionMode: "sequential",
    execute: async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            evidence: evidenceItems.map(({ id, pageId }) => ({ id, pageId }))
          })
        }
      ],
      details: { resultCount: evidenceItems.length }
    })
  };
}

function knowledgeReadTool(): AgentTool<ReadParameters> {
  return {
    name: "knowledge.read",
    label: "knowledge.read",
    description: "读取证据片段",
    parameters: READ_PARAMETERS,
    executionMode: "sequential",
    execute: async (_toolCallId: string, params: { evidenceIds: string[] }) => {
      const wanted = new Set(params.evidenceIds);
      const pages = evidenceItems
        .filter(({ id }) => wanted.has(id))
        .map(({ pageId, text }) => ({ pageId, content: text }));
      if (!pages.length) throw new Error("KNOWLEDGE_READ_EMPTY");
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ readPages: pages }) }],
        details: { resultCount: pages.length }
      };
    }
  };
}

function gatewayLoopConfig(): AgentLoopConfig {
  return {
    model: {
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
    },
    toolExecution: "sequential",
    convertToLlm: (messages) => messages as never
  };
}

function scriptedGateway(responses: ModelResponse[], requests: ModelRequest[]): ModelGateway {
  return {
    invoke(request: ModelRequest) {
      // Mirrors the real gateway preflight: an aborted request is refused
      // before any provider call or scripted response is consumed.
      if (request.signal?.aborted) return Promise.reject(new Error("MODEL_PROVIDER_CANCELLED"));
      requests.push(request);
      const response = responses.shift();
      if (!response) return Promise.reject(new Error("MODEL_GATEWAY_EXHAUSTED"));
      return Promise.resolve(response);
    }
  } as unknown as ModelGateway;
}

function toolCallResponse(id: string, name: string, argumentsJson: string): ModelResponse {
  return {
    providerId: "provider-1",
    model: "model-1",
    durationMs: 1,
    output: { type: "tool_calls", toolCalls: [{ id, name, arguments: argumentsJson }] }
  };
}

function textResponse(text: string): ModelResponse {
  return { providerId: "provider-1", model: "model-1", durationMs: 1, output: text };
}

/** Folds raw loop events through the exact adapter mapping (ADR 0005). */
function foldPiEvents(events: readonly AgentEvent[], runId: string): AgentCoreEvent[] {
  const folded: AgentCoreEvent[] = [{ type: "run.started", runId }];
  for (const event of events) {
    if (event.type === "agent_end") {
      folded.push(piTerminalAgentCoreEvent(event.messages, runId));
      continue;
    }
    folded.push(...mapPiAgentEvent(event, runId));
  }
  return folded;
}

async function replayScript(script: readonly AgentCoreScriptEvent[], runId: string) {
  return collectAgentCoreEvents(new PiAgentCoreAdapter(), { runId, script });
}

describe("gateway bridge inside the real pi loop", () => {
  it("runs a search -> read -> answer tool loop through the gateway", async () => {
    const requests: ModelRequest[] = [];
    const responses: ModelResponse[] = [
      {
        providerId: "provider-1",
        model: "model-1",
        durationMs: 1,
        output: {
          type: "tool_calls",
          toolCalls: [
            { id: "call-search", name: "knowledge.search", arguments: '{"query":"间隔检索"}' }
          ]
        }
      },
      {
        providerId: "provider-1",
        model: "model-1",
        durationMs: 1,
        output: {
          type: "tool_calls",
          toolCalls: [
            { id: "call-read", name: "knowledge.read", arguments: '{"evidenceIds":["e1"]}' }
          ]
        }
      },
      { providerId: "provider-1", model: "model-1", durationMs: 1, output: "基于证据一的回答。" }
    ];
    const gateway = {
      invoke(request: ModelRequest) {
        requests.push(request);
        const response = responses.shift();
        if (!response) throw new Error("MODEL_GATEWAY_EXHAUSTED");
        return Promise.resolve(response);
      }
    } as unknown as ModelGateway;

    const events: AgentEvent[] = [];
    // Canonical wiring: the user turn arrives as the agentLoop prompt and is
    // appended to the (empty) history once — passing it in both places would
    // duplicate it in the gateway payload.
    const loop = agentLoop(
      [{ role: "user", content: "间隔检索怎么做？", timestamp: 0 }],
      {
        systemPrompt: "grounded assistant",
        messages: [],
        tools: [knowledgeSearchTool(), knowledgeReadTool()]
      },
      {
        model: {
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
        },
        toolExecution: "sequential",
        convertToLlm: (messages) => messages as never
      },
      undefined,
      createGatewayStreamFn(gateway, { dataPolicy: "local_only", purpose: "agent" })
    );
    for await (const event of loop) events.push(event);
    const finalMessages = await loop.result();

    const toolSequence = events
      .filter((event) => event.type.startsWith("tool_execution"))
      .map((event) =>
        event.type === "tool_execution_start"
          ? `+${event.toolName}`
          : event.type === "tool_execution_end"
            ? `-${event.toolName}`
            : ""
      );
    expect(toolSequence).toEqual([
      "+knowledge.search",
      "-knowledge.search",
      "+knowledge.read",
      "-knowledge.read"
    ]);
    const lastAssistant = [...finalMessages]
      .reverse()
      .find((message) => message?.role === "assistant");
    expect(lastAssistant).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "基于证据一的回答。" }],
      stopReason: "stop"
    });

    // The gateway saw the full grounded conversation shape: system + user +
    // assistant tool calls + tool results + tool definitions.
    expect(requests).toHaveLength(3);
    const lastPayload = requests[2].payload as {
      messages: Array<Record<string, unknown>>;
      tools: Array<Record<string, string>>;
    };
    expect(lastPayload.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool"
    ]);
    expect(lastPayload.tools.map((tool) => tool.function?.name ?? "")).toEqual([
      "knowledge.search",
      "knowledge.read"
    ]);
    const toolResults = lastPayload.messages.filter((message) => message.role === "tool");
    expect(toolResults[0]).toMatchObject({ tool_call_id: "call-search", name: "knowledge.search" });
    expect(toolResults[1]).toMatchObject({ tool_call_id: "call-read", name: "knowledge.read" });
  });

  it("ends the run with a stable failure code when the gateway budget is exceeded", async () => {
    const gateway = {
      invoke() {
        return Promise.reject(new Error("MODEL_BUDGET_EXCEEDED"));
      }
    } as unknown as ModelGateway;
    const streamFn = createGatewayStreamFn(gateway, { dataPolicy: "local_only", purpose: "agent" });
    const loop = agentLoop(
      [{ role: "user", content: "q", timestamp: 0 }],
      {
        systemPrompt: "",
        messages: []
      },
      {
        model: {
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
        },
        convertToLlm: (messages) => messages as never
      },
      undefined,
      streamFn
    );
    const events: AgentEvent[] = [];
    for await (const event of loop) events.push(event);
    const finalMessages = await loop.result();
    const lastAssistant = [...finalMessages]
      .reverse()
      .find((message) => message?.role === "assistant") as
      { stopReason: string; errorMessage?: string } | undefined;
    expect(lastAssistant?.stopReason).toBe("error");
    expect(lastAssistant?.errorMessage).toBe("MODEL_BUDGET_EXCEEDED");
    expect(events.at(-1)?.type).toBe("agent_end");
  });

  it("is event-for-event equivalent to the scripted adapter replay of the same trace", async () => {
    const requests: ModelRequest[] = [];
    const gateway = scriptedGateway(
      [
        toolCallResponse("call-search", "knowledge.search", '{"query":"间隔检索"}'),
        toolCallResponse("call-read", "knowledge.read", '{"evidenceIds":["e1"]}'),
        textResponse("基于证据一的回答。")
      ],
      requests
    );
    const events: AgentEvent[] = [];
    const loop = agentLoop(
      [{ role: "user", content: "间隔检索怎么做？", timestamp: 0 }],
      {
        systemPrompt: "grounded assistant",
        messages: [],
        tools: [knowledgeSearchTool(), knowledgeReadTool()]
      },
      gatewayLoopConfig(),
      undefined,
      createGatewayStreamFn(gateway, { dataPolicy: "local_only", purpose: "agent" })
    );
    for await (const event of loop) events.push(event);
    await loop.result();

    const folded = foldPiEvents(events, "run-equivalence");
    const scripted = await replayScript(
      [
        {
          type: "tool.requested",
          toolCallId: "call-search",
          tool: "knowledge.search",
          inputSummary: '{"query":"间隔检索"}'
        },
        { type: "tool.completed", toolCallId: "call-search", outputSummary: '{"resultCount":2}' },
        {
          type: "tool.requested",
          toolCallId: "call-read",
          tool: "knowledge.read",
          inputSummary: '{"evidenceIds":["e1"]}'
        },
        { type: "tool.completed", toolCallId: "call-read", outputSummary: '{"resultCount":1}' },
        { type: "assistant.delta", text: "基于证据一的回答。" },
        { type: "run.completed" }
      ],
      "run-equivalence"
    );
    expect(folded).toEqual(scripted);
  });

  it("stops the whole run when the caller aborts between tool rounds", async () => {
    const controller = new AbortController();
    const requests: ModelRequest[] = [];
    const pending: ModelResponse[] = [
      toolCallResponse("call-search", "knowledge.search", '{"query":"间隔检索"}'),
      toolCallResponse("call-read", "knowledge.read", '{"evidenceIds":["e1"]}'),
      textResponse("never reached")
    ];
    const gateway = scriptedGateway(pending, requests);
    const search = knowledgeSearchTool();
    const abortingSearch: AgentTool<SearchParameters> = {
      ...search,
      execute: async (toolCallId: string, params: SearchParameters) => {
        controller.abort();
        return search.execute(toolCallId, params);
      }
    };
    const events: AgentEvent[] = [];
    const loop = agentLoop(
      [{ role: "user", content: "间隔检索怎么做？", timestamp: 0 }],
      {
        systemPrompt: "grounded assistant",
        messages: [],
        tools: [abortingSearch, knowledgeReadTool()]
      },
      gatewayLoopConfig(),
      controller.signal,
      createGatewayStreamFn(gateway, { dataPolicy: "local_only", purpose: "agent" })
    );
    for await (const event of loop) events.push(event);
    await loop.result();

    expect(foldPiEvents(events, "run-cancel")).toEqual([
      { type: "run.started", runId: "run-cancel" },
      {
        type: "tool.requested",
        runId: "run-cancel",
        toolCallId: "call-search",
        tool: "knowledge.search",
        inputSummary: '{"query":"间隔检索"}'
      },
      {
        type: "tool.completed",
        runId: "run-cancel",
        toolCallId: "call-search",
        outputSummary: '{"resultCount":2}'
      },
      { type: "run.stopped", runId: "run-cancel", reason: "cancelled" }
    ]);
    // The read round and the final answer were never requested or executed.
    expect(requests).toHaveLength(1);
    expect(pending).toHaveLength(2);
    expect(
      events.filter((event) => event.type === "tool_execution_start").map((event) => event.toolName)
    ).toEqual(["knowledge.search"]);
  });

  it("carries the prior turn into the next user turn exactly once", async () => {
    const requests: ModelRequest[] = [];
    const gateway = scriptedGateway(
      [
        toolCallResponse("call-search", "knowledge.search", '{"query":"间隔检索"}'),
        textResponse("第一回合的回答。"),
        textResponse("第二回合的回答。")
      ],
      requests
    );
    const streamFn = createGatewayStreamFn(gateway, { dataPolicy: "local_only", purpose: "agent" });

    const turnOneContext: AgentContext = {
      systemPrompt: "grounded assistant",
      messages: [],
      tools: [knowledgeSearchTool(), knowledgeReadTool()]
    };
    const eventsOne: AgentEvent[] = [];
    const runOne = agentLoop(
      [{ role: "user", content: "间隔检索怎么做？", timestamp: 0 }],
      turnOneContext,
      gatewayLoopConfig(),
      undefined,
      streamFn
    );
    for await (const event of runOne) eventsOne.push(event);
    const turnOneMessages = await runOne.result();

    // A follow-up turn is a new run over the accumulated history; pi copies
    // the caller's array, so the base history stays untouched.
    expect(turnOneContext.messages).toHaveLength(0);
    const turnTwoContext: AgentContext = {
      ...turnOneContext,
      messages: [...turnOneContext.messages, ...turnOneMessages]
    };
    const eventsTwo: AgentEvent[] = [];
    const runTwo = agentLoop(
      [{ role: "user", content: "第一回合之后呢？", timestamp: 0 }],
      turnTwoContext,
      gatewayLoopConfig(),
      undefined,
      streamFn
    );
    for await (const event of runTwo) eventsTwo.push(event);
    await runTwo.result();

    const turnTwoPayload = requests[2].payload as {
      messages: Array<Record<string, unknown>>;
    };
    expect(turnTwoPayload.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "user"
    ]);
    expect(foldPiEvents(eventsOne, "run-turn-1")).toEqual(
      await replayScript(
        [
          {
            type: "tool.requested",
            toolCallId: "call-search",
            tool: "knowledge.search",
            inputSummary: '{"query":"间隔检索"}'
          },
          { type: "tool.completed", toolCallId: "call-search", outputSummary: '{"resultCount":2}' },
          { type: "assistant.delta", text: "第一回合的回答。" },
          { type: "run.completed" }
        ],
        "run-turn-1"
      )
    );
    expect(foldPiEvents(eventsTwo, "run-turn-2")).toEqual(
      await replayScript(
        [{ type: "assistant.delta", text: "第二回合的回答。" }, { type: "run.completed" }],
        "run-turn-2"
      )
    );
  });
});

describe("pi adapter privilege guard", () => {
  it("keeps the pi adapter imports limited to pi packages and the local contract", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/pi-adapter.ts", import.meta.url)),
      "utf8"
    );
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(
        specifier.startsWith("@earendil-works/") || specifier.startsWith("./"),
        `unexpected import ${specifier}`
      ).toBe(true);
    }
    expect(source).not.toMatch(/\bnode:(fs|net|child_process|http|crypto|dns)\b/);
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/getDatabase|pg-boss/);
  });

  it("keeps the gateway bridge imports limited to pi, contracts and the model gateway", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/model-gateway-bridge.ts", import.meta.url)),
      "utf8"
    );
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    for (const specifier of imports) {
      expect(
        specifier.startsWith("@earendil-works/") ||
          specifier.startsWith("./") ||
          specifier === "@wknowledge/contracts" ||
          specifier === "@wknowledge/model-gateway",
        `unexpected import ${specifier}`
      ).toBe(true);
    }
    expect(source).not.toMatch(/\bnode:(fs|net|child_process|http|dns)\b/);
    expect(source).not.toMatch(/process\.env|getDatabase|pg-boss/);
  });
});
