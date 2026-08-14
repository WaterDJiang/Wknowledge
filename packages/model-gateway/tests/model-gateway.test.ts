import { describe, expect, it, vi } from "vitest";
import {
  ModelGateway,
  OpenAICompatibleProvider,
  decryptCredential,
  encryptCredential,
  type ModelProvider
} from "../src/index";

const provider: ModelProvider = {
  id: "local",
  location: "local",
  capabilities: new Set(["chat", "embedding"]),
  healthcheck: async () => true,
  invoke: vi.fn(async () => ({ providerId: "local", model: "test", output: "ok", durationMs: 1 }))
};

describe("ModelGateway", () => {
  it("encrypts provider credentials and rejects the wrong master key", () => {
    const key = Buffer.alloc(32, 7).toString("base64url");
    const encrypted = encryptCredential("provider-secret", key);
    expect(JSON.stringify(encrypted)).not.toContain("provider-secret");
    expect(decryptCredential(encrypted, key)).toBe("provider-secret");
    expect(() => decryptCredential(encrypted, Buffer.alloc(32, 8).toString("base64url"))).toThrow(
      "CREDENTIAL_DECRYPT_FAILED"
    );
  });
  it("never calls embedding for MVP wiki queries", async () => {
    const gateway = new ModelGateway();
    gateway.register(provider);
    await expect(
      gateway.invoke({
        capability: "embedding",
        dataPolicy: "local_only",
        purpose: "wiki_query",
        payload: "q"
      })
    ).rejects.toThrow("WIKI_EMBEDDING_FORBIDDEN");
  });

  it("does not route local-only or unredacted policies to cloud providers", async () => {
    const cloud: ModelProvider = {
      id: "cloud",
      location: "cloud",
      capabilities: new Set(["chat"]),
      healthcheck: async () => true,
      invoke: vi.fn(async () => ({
        providerId: "cloud",
        model: "test",
        output: "ok",
        durationMs: 1
      }))
    };
    const gateway = new ModelGateway();
    gateway.register(cloud);
    for (const dataPolicy of ["local_only", "cloud_allowed_after_redaction"] as const)
      await expect(
        gateway.invoke({ capability: "chat", dataPolicy, purpose: "wiki_query", payload: {} })
      ).rejects.toThrow("MODEL_CAPABILITY_UNAVAILABLE");
    expect(cloud.invoke).not.toHaveBeenCalled();
  });

  it("uses only healthy providers", async () => {
    const unhealthy: ModelProvider = {
      id: "unhealthy",
      location: "local",
      capabilities: new Set(["chat"]),
      healthcheck: async () => false,
      invoke: vi.fn()
    };
    const healthy: ModelProvider = {
      id: "healthy",
      location: "local",
      capabilities: new Set(["chat"]),
      healthcheck: async () => true,
      invoke: vi.fn(async () => ({
        providerId: "healthy",
        model: "grounded",
        output: "ok",
        durationMs: 2
      }))
    };
    const gateway = new ModelGateway();
    gateway.register(unhealthy);
    gateway.register(healthy);
    await expect(
      gateway.invoke({
        capability: "chat",
        dataPolicy: "local_only",
        purpose: "wiki_query",
        payload: {}
      })
    ).resolves.toMatchObject({ providerId: "healthy" });
    expect(unhealthy.invoke).not.toHaveBeenCalled();
  });

  it("runs the invocation guard only after a healthy compatible provider is selected", async () => {
    const invoke = vi.fn(async () => ({
      providerId: "guarded",
      model: "test",
      output: "ok",
      durationMs: 1
    }));
    const guarded: ModelProvider = {
      id: "guarded",
      location: "local",
      capabilities: new Set(["chat"]),
      healthcheck: async () => true,
      invoke
    };
    const beforeInvoke = vi.fn(async () => {
      throw new Error("MODEL_BUDGET_EXCEEDED");
    });
    const gateway = new ModelGateway({ beforeInvoke });
    gateway.register(guarded);
    await expect(
      gateway.invoke({
        capability: "chat",
        dataPolicy: "local_only",
        purpose: "agent",
        payload: {}
      })
    ).rejects.toThrow("MODEL_BUDGET_EXCEEDED");
    expect(beforeInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "guarded", purpose: "agent" })
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses the next healthy provider when only one provider budget is exhausted", async () => {
    const firstInvoke = vi.fn();
    const secondInvoke = vi.fn(async () => ({
      providerId: "second",
      model: "test",
      output: "ok",
      durationMs: 1
    }));
    const beforeInvoke = vi.fn(async ({ providerId }: { providerId: string }) => {
      if (providerId === "first") throw new Error("MODEL_PROVIDER_BUDGET_EXCEEDED");
    });
    const gateway = new ModelGateway({ beforeInvoke });
    gateway.register({
      id: "first",
      location: "local",
      capabilities: new Set(["chat"]),
      healthcheck: async () => true,
      invoke: firstInvoke
    });
    gateway.register({
      id: "second",
      location: "local",
      capabilities: new Set(["chat"]),
      healthcheck: async () => true,
      invoke: secondInvoke
    });
    await expect(
      gateway.invoke({
        capability: "chat",
        dataPolicy: "local_only",
        purpose: "agent",
        payload: {}
      })
    ).resolves.toMatchObject({ providerId: "second" });
    expect(firstInvoke).not.toHaveBeenCalled();
    expect(secondInvoke).toHaveBeenCalledOnce();
  });

  it("calls an OpenAI-compatible chat endpoint without exposing its key", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: '{"answer":"有据回答"}' } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const compatible = new OpenAICompatibleProvider(
      {
        id: "local-chat",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen",
        location: "local",
        apiKey: "server-secret",
        timeoutMs: 1000
      },
      fetcher
    );
    const response = await compatible.invoke({
      capability: "chat",
      dataPolicy: "local_only",
      purpose: "wiki_query",
      payload: { messages: [{ role: "user", content: "问题" }] }
    });
    expect(response.output).toBe('{"answer":"有据回答"}');
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/chat/completions",
      expect.objectContaining({ method: "POST", redirect: "error" })
    );
    expect(JSON.stringify(response)).not.toContain("server-secret");
  });

  it("uses pinned transport for cloud providers even when an ordinary fetch seam is supplied", async () => {
    vi.stubEnv("WKNOWLEDGE_CLOUD_PROVIDER_HOST_ALLOWLIST", "models.example.test");
    const ordinaryFetch = vi.fn(async () => new Response("ordinary fetch must not be used"));
    const pinnedFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: '{"answer":"固定传输"}' } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const compatible = new OpenAICompatibleProvider(
      {
        id: "cloud-chat",
        baseUrl: "https://models.example.test/v1",
        model: "cloud-model",
        location: "cloud",
        timeoutMs: 1_000
      },
      ordinaryFetch,
      async () => [{ address: "8.8.8.8" }],
      pinnedFetch
    );

    try {
      await expect(
        compatible.invoke({
          capability: "chat",
          dataPolicy: "cloud_allowed",
          purpose: "agent",
          payload: { messages: [{ role: "user", content: "有来源的问题" }] }
        })
      ).resolves.toMatchObject({ output: '{"answer":"固定传输"}' });

      expect(pinnedFetch).toHaveBeenCalledWith(
        "https://models.example.test/v1/chat/completions",
        expect.objectContaining({ method: "POST", redirect: "error" }),
        "8.8.8.8"
      );
      expect(ordinaryFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("routes a declared vision capability through the compatible chat endpoint", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: '{"description":"课程封面"}' } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const compatible = new OpenAICompatibleProvider(
      {
        id: "local-vision",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen-vl",
        location: "local",
        capabilities: ["vision"],
        timeoutMs: 1_000
      },
      fetcher
    );

    await expect(
      compatible.invoke({
        capability: "vision",
        dataPolicy: "local_only",
        purpose: "video_understanding",
        payload: {
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/" } }]
            }
          ]
        }
      })
    ).resolves.toMatchObject({ output: '{"description":"课程封面"}' });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/chat/completions",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("forwards tool definitions and normalizes an OpenAI-compatible tool call", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "call_search",
                      type: "function",
                      function: { name: "knowledge.search", arguments: "{}" }
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const compatible = new OpenAICompatibleProvider(
      {
        id: "tool-chat",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "tool-model",
        location: "local",
        timeoutMs: 1_000
      },
      fetcher
    );

    const response = await compatible.invoke({
      capability: "chat",
      dataPolicy: "local_only",
      purpose: "wiki_query",
      payload: {
        messages: [{ role: "user", content: "问题" }],
        tools: [{ type: "function", function: { name: "knowledge.search", parameters: {} } }]
      }
    });

    expect(response.output).toEqual({
      type: "tool_calls",
      toolCalls: [{ id: "call_search", name: "knowledge.search", arguments: "{}" }]
    });
    const requestBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(requestBody.tools).toEqual([
      { type: "function", function: { name: "knowledge.search", parameters: {} } }
    ]);
    expect(requestBody).not.toHaveProperty("response_format");
  });

  it("propagates caller cancellation to a chat request", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          {
            once: true
          }
        );
      });
      return new Response();
    });
    const compatible = new OpenAICompatibleProvider(
      {
        id: "cancellable-chat",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen",
        location: "local",
        timeoutMs: 10_000
      },
      fetcher
    );
    const controller = new AbortController();
    const run = compatible.invoke({
      capability: "chat",
      dataPolicy: "local_only",
      purpose: "agent",
      payload: { messages: [] },
      signal: controller.signal
    });
    controller.abort();
    await expect(run).rejects.toThrow("MODEL_PROVIDER_CANCELLED");
  });

  it("requests verbose ASR JSON and preserves valid provider time segments", async () => {
    let receivedInit: RequestInit | undefined;
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      receivedInit = init;
      return new Response(
        JSON.stringify({
          text: "可回查的转写文本。第二段。",
          segments: [
            { start: 0, end: 1.25, text: "可回查的转写文本。" },
            { start: 1.25, end: 2, text: "第二段。" }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    const compatible = new OpenAICompatibleProvider(
      {
        id: "local-asr",
        baseUrl: "http://127.0.0.1:9000/v1",
        model: "whisper",
        location: "local",
        capabilities: ["speech_to_text"],
        apiKey: "server-secret",
        timeoutMs: 1000
      },
      fetcher
    );
    const response = await compatible.invoke({
      capability: "speech_to_text",
      dataPolicy: "local_only",
      purpose: "speech_to_text",
      payload: { file: new Blob(["audio"], { type: "audio/wav" }), fileName: "lesson.wav" }
    });

    expect(response.output).toEqual({
      text: "可回查的转写文本。第二段。",
      segments: [
        { startMs: 0, endMs: 1_250, text: "可回查的转写文本。" },
        { startMs: 1_250, endMs: 2_000, text: "第二段。" }
      ]
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:9000/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) })
    );
    expect(receivedInit?.headers).toEqual({ authorization: "Bearer server-secret" });
    const form = receivedInit?.body as FormData;
    expect(form.get("response_format")).toBe("verbose_json");
    expect(JSON.stringify(response)).not.toContain("server-secret");
  });

  it("falls back to whole-media text when ASR segment payload is invalid", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ text: "完整转写", segments: [{ start: 2, end: 1, text: "坏片段" }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
    );
    const compatible = new OpenAICompatibleProvider(
      {
        id: "fallback-asr",
        baseUrl: "http://127.0.0.1:9000/v1",
        model: "whisper",
        location: "local",
        capabilities: ["speech_to_text"],
        timeoutMs: 1000
      },
      fetcher
    );
    await expect(
      compatible.invoke({
        capability: "speech_to_text",
        dataPolicy: "local_only",
        purpose: "speech_to_text",
        payload: { file: new Blob(["audio"], { type: "audio/wav" }), fileName: "lesson.wav" }
      })
    ).resolves.toMatchObject({ output: { text: "完整转写", segments: null } });
  });

  it("never routes speech-to-text to cloud providers without a compatible policy", async () => {
    const cloudAsr: ModelProvider = {
      id: "cloud-asr",
      location: "cloud",
      capabilities: new Set(["speech_to_text"]),
      healthcheck: async () => true,
      invoke: vi.fn()
    };
    const gateway = new ModelGateway();
    gateway.register(cloudAsr);

    await expect(
      gateway.invoke({
        capability: "speech_to_text",
        dataPolicy: "cloud_allowed_after_redaction",
        purpose: "speech_to_text",
        payload: {}
      })
    ).rejects.toThrow("MODEL_CAPABILITY_UNAVAILABLE");
    expect(cloudAsr.invoke).not.toHaveBeenCalled();
  });
});
