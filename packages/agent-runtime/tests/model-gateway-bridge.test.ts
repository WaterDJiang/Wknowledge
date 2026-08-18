import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { ModelGateway, ModelRequest, ModelResponse } from "@wknowledge/model-gateway";
import { contextToGatewayPayload, createGatewayStreamFn } from "../src/index";

function fakeGateway(respond: (request: ModelRequest) => Promise<ModelResponse>): {
  gateway: ModelGateway;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  return {
    requests,
    gateway: {
      invoke(request: ModelRequest) {
        requests.push(request);
        return respond(request);
      }
    } as unknown as ModelGateway
  };
}

const context: Context = {
  systemPrompt: "system prompt",
  messages: [
    { role: "user", content: "question", timestamp: 0 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "knowledge.search", arguments: {} }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: "toolUse",
      timestamp: 0
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "knowledge.search",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 0
    }
  ],
  tools: [
    {
      name: "knowledge.search",
      description: "search",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  ]
};

async function collect(stream: AsyncIterable<{ type: string }>): Promise<string[]> {
  const types: string[] = [];
  for await (const event of stream) types.push(event.type);
  return types;
}

describe("context to gateway payload", () => {
  it("maps user, assistant tool call, tool result and tool definitions", () => {
    const payload = contextToGatewayPayload(context, context.tools ?? []) as {
      messages: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
    };
    expect(payload.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "question" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "knowledge.search", arguments: "{}" }
          }
        ]
      },
      { role: "tool", tool_call_id: "call-1", name: "knowledge.search", content: "result" }
    ]);
    expect(payload.tools).toEqual([
      {
        type: "function",
        function: {
          name: "knowledge.search",
          description: "search",
          parameters: { type: "object", properties: {}, additionalProperties: false }
        }
      }
    ]);
  });

  it("fails closed on unsupported message roles", () => {
    const unsupported = { ...context, messages: [{ role: "custom" } as never] };
    expect(() => contextToGatewayPayload(unsupported, [])).toThrow("PI_CONTEXT_UNSUPPORTED");
  });
});

describe("gateway stream fn", () => {
  it("synthesizes a text stream from a successful response", async () => {
    const { gateway, requests } = fakeGateway(async () => ({
      providerId: "provider-1",
      model: "model-1",
      output: "answer text",
      durationMs: 5
    }));
    const streamFn = createGatewayStreamFn(gateway, { dataPolicy: "local_only", purpose: "agent" });
    const events = await collect(streamFn({} as never, context, {}));
    expect(events).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(requests[0]).toMatchObject({
      capability: "chat",
      dataPolicy: "local_only",
      purpose: "agent"
    });
  });

  it("synthesizes tool call events and keeps the loop reason toolUse", async () => {
    const { gateway } = fakeGateway(async () => ({
      providerId: "provider-1",
      model: "model-1",
      output: {
        type: "tool_calls",
        toolCalls: [{ id: "call-9", name: "knowledge.read", arguments: '{"evidenceIds":["e1"]}' }]
      },
      durationMs: 5
    }));
    const streamFn = createGatewayStreamFn(gateway, { dataPolicy: "local_only", purpose: "agent" });
    const collected: Array<Record<string, unknown>> = [];
    for await (const event of streamFn({} as never, context, {}))
      collected.push(event as Record<string, unknown>);
    expect(collected.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
    const toolCallEnd = collected.find((event) => event.type === "toolcall_end") as {
      toolCall: { id: string; name: string; arguments: { evidenceIds: string[] } };
    };
    expect(toolCallEnd.toolCall).toEqual({
      type: "toolCall",
      id: "call-9",
      name: "knowledge.read",
      arguments: { evidenceIds: ["e1"] }
    });
  });

  it("maps gateway failures to a stable error event", async () => {
    const { gateway } = fakeGateway(async () => {
      throw new Error("MODEL_BUDGET_EXCEEDED");
    });
    const streamFn = createGatewayStreamFn(gateway, { dataPolicy: "local_only", purpose: "agent" });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of streamFn({} as never, context, {}))
      events.push(event as Record<string, unknown>);
    expect(events).toEqual([
      {
        type: "error",
        reason: "error",
        error: expect.objectContaining({
          stopReason: "error",
          errorMessage: "MODEL_BUDGET_EXCEEDED"
        })
      }
    ]);
    const failure = events[0].error as AssistantMessage;
    expect(failure.content).toEqual([]);
  });

  it("normalizes non-code gateway errors", async () => {
    const { gateway } = fakeGateway(async () => {
      throw new Error("boom");
    });
    const streamFn = createGatewayStreamFn(gateway, { dataPolicy: "local_only", purpose: "agent" });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of streamFn({} as never, context, {}))
      events.push(event as Record<string, unknown>);
    expect((events[0].error as AssistantMessage).errorMessage).toBe("MODEL_GATEWAY_FAILED");
  });

  it("forwards unsupported context shapes as a stream error instead of throwing", async () => {
    const { gateway } = fakeGateway(async () => ({
      providerId: "p",
      model: "m",
      output: "ok",
      durationMs: 1
    }));
    const streamFn = createGatewayStreamFn(gateway, { dataPolicy: "local_only", purpose: "agent" });
    const events: Array<Record<string, unknown>> = [];
    const unsupported = { ...context, messages: [{ role: "custom" } as never] };
    for await (const event of streamFn({} as never, unsupported, {}))
      events.push(event as Record<string, unknown>);
    expect((events[0].error as AssistantMessage).errorMessage).toBe("PI_CONTEXT_UNSUPPORTED");
  });

  it("passes the abort signal through to the gateway", async () => {
    const controller = new AbortController();
    const { gateway, requests } = fakeGateway(async () => ({
      providerId: "p",
      model: "m",
      output: "ok",
      durationMs: 1
    }));
    const streamFn = createGatewayStreamFn(gateway, {
      dataPolicy: "local_only",
      purpose: "agent",
      signal: controller.signal
    });
    await collect(streamFn({} as never, context, {}));
    expect(requests[0].signal).toBe(controller.signal);
  });

  it("prefers the per-call signal and combines it with the construction-time signal", async () => {
    const own = new AbortController();
    const perCall = new AbortController();
    const { gateway, requests } = fakeGateway(async () => ({
      providerId: "p",
      model: "m",
      output: "ok",
      durationMs: 1
    }));
    const streamFn = createGatewayStreamFn(gateway, {
      dataPolicy: "local_only",
      purpose: "agent",
      signal: own.signal
    });
    await collect(streamFn({} as never, context, { signal: perCall.signal }));
    const forwarded = requests[0].signal;
    expect(forwarded).toBeDefined();
    expect(forwarded).not.toBe(own.signal);
    expect(forwarded).not.toBe(perCall.signal);
    own.abort();
    expect(forwarded?.aborted).toBe(true);
  });

  it("folds an aborted gateway rejection into an aborted stop reason, not a failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const { gateway } = fakeGateway(() => {
      throw new Error("MODEL_PROVIDER_CANCELLED");
    });
    const streamFn = createGatewayStreamFn(gateway, {
      dataPolicy: "local_only",
      purpose: "agent",
      signal: controller.signal
    });
    const events: Array<Record<string, unknown>> = [];
    for await (const event of streamFn({} as never, context, {}))
      events.push(event as Record<string, unknown>);
    expect(events).toEqual([
      {
        type: "error",
        reason: "aborted",
        error: expect.objectContaining({ stopReason: "aborted" })
      }
    ]);
    expect((events[0].error as AssistantMessage).errorMessage).toBeUndefined();
  });
});
