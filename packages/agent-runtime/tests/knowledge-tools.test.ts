import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentLoop } from "@earendil-works/pi-agent-core";
import type { ModelGateway, ModelRequest, ModelResponse } from "@wknowledge/model-gateway";
import { compileWiki, initializeSpace } from "@wknowledge/wiki";
import type { EvidenceBundle as EvidenceBundleT } from "@wknowledge/contracts";
import {
  createAgentToolRegistry,
  createBoundKnowledgeComponent,
  createGatewayStreamFn,
  createKnowledgeTools,
  finalizeGroundedAnswer,
  runBoundKnowledgeAgent,
  searchToolOutput,
  type AgentToolPolicyBridge,
  type KnowledgeComponent
} from "../src/index";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
);

const allowAll: AgentToolPolicyBridge = {
  async beforeToolCall() {
    return { allow: true };
  },
  async afterToolCall() {
    return {};
  }
};

const LOOP_MODEL = {
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
};

function gatewayWith(responses: ModelResponse[]): {
  gateway: ModelGateway;
  toolContents: string[];
} {
  const requests: ModelRequest[] = [];
  return {
    gateway: {
      invoke(request: ModelRequest) {
        requests.push(request);
        const response = responses.shift();
        if (!response) throw new Error("MODEL_GATEWAY_EXHAUSTED");
        return Promise.resolve(response);
      }
    } as unknown as ModelGateway,
    get toolContents() {
      const last = requests.at(-1);
      if (!last) return [];
      return (last.payload as { messages: unknown[] }).messages
        .filter((message) => (message as { role?: string }).role === "tool")
        .map((message) => (message as { content: string }).content);
    }
  };
}

function textResponse(text: string): ModelResponse {
  return { providerId: "provider-1", model: "model-1", durationMs: 1, output: text };
}

function generatedAnswerResponse(evidenceIds: string[]): ModelResponse {
  return textResponse(
    JSON.stringify({
      answer: "应每天练习。",
      evidenceIds,
      insufficientEvidence: false,
      mode: "generated"
    })
  );
}

function toolCallResponse(id: string, name: string, argumentsJson: string): ModelResponse {
  return {
    providerId: "provider-1",
    model: "model-1",
    durationMs: 1,
    output: { type: "tool_calls", toolCalls: [{ id, name, arguments: argumentsJson }] }
  };
}

async function compiledSpace(): Promise<{ spaceId: string; spaceRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "wknowledge-tools-"));
  roots.push(root);
  const spaceId = randomUUID();
  const versionId = randomUUID();
  const spaceRoot = await initializeSpace(root, spaceId);
  await compileWiki(spaceRoot, {
    spaceId,
    resourceVersionId: versionId,
    resourceName: "memory.md",
    profile: "knowledge",
    nodes: [
      {
        schemaVersion: 1,
        id: "memory",
        kind: "paragraph",
        content: "间隔检索应每天练习。",
        order: 0,
        locator: { type: "document", resourceVersionId: versionId, nodeId: "memory" },
        metadata: {}
      }
    ]
  });
  return { spaceId, spaceRoot };
}

function componentOver(spaceId: string, spaceRoot: string): KnowledgeComponent {
  return createBoundKnowledgeComponent({
    scopes: [{ bindingId: "binding", kind: "space", spaceId, label: "记忆空间" }],
    resolveSpaceRoot: async () => spaceRoot,
    openSource: async (input) => ({
      bindingId: input.scope.bindingId,
      spaceId: input.scope.spaceId,
      evidenceId: input.evidenceId,
      sourceIndex: input.sourceIndex,
      sourceRef: input.sourceRef
    })
  });
}

async function runPiTurn(input: {
  component: KnowledgeComponent;
  question: string;
  responses: ModelResponse[];
}): Promise<string[]> {
  const registry = createAgentToolRegistry();
  for (const tool of createKnowledgeTools(input.component, { question: input.question })) {
    registry.register(tool);
  }
  const harness = gatewayWith(input.responses);
  const loop = agentLoop(
    [{ role: "user", content: input.question, timestamp: 0 }],
    { systemPrompt: "", messages: [], tools: registry.toPiTools() },
    {
      model: LOOP_MODEL,
      toolExecution: "sequential",
      convertToLlm: (messages) => messages as never,
      ...registry.policyHooks(allowAll)
    },
    undefined,
    createGatewayStreamFn(harness.gateway, { dataPolicy: "local_only", purpose: "wiki_query" })
  );
  for await (const event of loop) void event;
  await loop.result();
  return harness.toolContents;
}

describe("knowledge pi tools vs the internal loop (bypass comparison)", () => {
  it("feeds the model byte-identical search payloads", async () => {
    const { spaceId, spaceRoot } = await compiledSpace();
    const question = "间隔检索";
    const probe = await runBoundKnowledgeAgent(
      randomUUID(),
      [{ bindingId: "binding", spaceId, spaceRoot }],
      question
    );
    const evidenceIds = probe.result.evidence.items.map(({ id }) => id);
    expect(evidenceIds.length).toBeGreaterThan(0);

    const internal = gatewayWith([
      toolCallResponse("call-search", "knowledge.search", "{}"),
      toolCallResponse("call-read", "knowledge.read", JSON.stringify({ evidenceIds })),
      generatedAnswerResponse(evidenceIds)
    ]);
    const internalRun = await runBoundKnowledgeAgent(
      randomUUID(),
      [{ bindingId: "binding", spaceId, spaceRoot }],
      question,
      {
        gateway: internal.gateway,
        dataPolicy: "local_only",
        enableToolLoop: true
      }
    );
    expect(internalRun.knowledgeToolCalls.map(({ name }) => name)).toEqual([
      "knowledge.search",
      "knowledge.read"
    ]);
    expect(internalRun.modelCall).toMatchObject({ status: "succeeded" });

    const piToolContents = await runPiTurn({
      component: componentOver(spaceId, spaceRoot),
      question,
      responses: [
        toolCallResponse("call-search", "knowledge.search", "{}"),
        textResponse("Pi 路径回答。")
      ]
    });

    expect(piToolContents[0]).toBe(internal.toolContents[0]);
    expect(piToolContents[0]).toBe(searchToolOutput(internalRun.result.evidence));
  });

  it("feeds the model byte-identical read payloads", async () => {
    const { spaceId, spaceRoot } = await compiledSpace();
    const question = "间隔检索";

    // Seed the evidence ids both loops will read.
    const probe = await runBoundKnowledgeAgent(
      randomUUID(),
      [{ bindingId: "binding", spaceId, spaceRoot }],
      question
    );
    const evidenceIds = probe.result.evidence.items.map(({ id }) => id);
    expect(evidenceIds.length).toBeGreaterThan(0);

    const internal = gatewayWith([
      toolCallResponse("call-search", "knowledge.search", "{}"),
      toolCallResponse("call-read", "knowledge.read", JSON.stringify({ evidenceIds })),
      generatedAnswerResponse(evidenceIds)
    ]);
    await runBoundKnowledgeAgent(
      randomUUID(),
      [{ bindingId: "binding", spaceId, spaceRoot }],
      question,
      {
        gateway: internal.gateway,
        dataPolicy: "local_only",
        enableToolLoop: true
      }
    );
    expect(internal.toolContents).toHaveLength(2);

    const component = componentOver(spaceId, spaceRoot);
    await component.search({ question });
    const piToolContents = await runPiTurn({
      component,
      question,
      responses: [
        toolCallResponse("call-read", "knowledge.read", JSON.stringify({ evidenceIds })),
        textResponse("Pi 路径回答。")
      ]
    });

    expect(piToolContents[0]).toBe(internal.toolContents[1]);
    const parsed = JSON.parse(piToolContents[0] ?? "{}") as { readPages: unknown[] };
    expect(parsed.readPages.length).toBeGreaterThan(0);
  });
});

describe("knowledge pi tool failures", () => {
  it("surfaces read-before-search as a recoverable tool error", async () => {
    const { spaceId, spaceRoot } = await compiledSpace();
    const errorEvents: string[] = [];
    const registry = createAgentToolRegistry();
    for (const tool of createKnowledgeTools(componentOver(spaceId, spaceRoot), {
      question: "间隔检索"
    })) {
      registry.register(tool);
    }
    const harness = gatewayWith([
      toolCallResponse("call-read", "knowledge.read", '{"evidenceIds":["evidence-01"]}'),
      textResponse("先搜索再读取。")
    ]);
    const loop = agentLoop(
      [{ role: "user", content: "间隔检索", timestamp: 0 }],
      { systemPrompt: "", messages: [], tools: registry.toPiTools() },
      {
        model: LOOP_MODEL,
        toolExecution: "sequential",
        convertToLlm: (messages) => messages as never,
        ...registry.policyHooks(allowAll)
      },
      undefined,
      createGatewayStreamFn(harness.gateway, { dataPolicy: "local_only", purpose: "wiki_query" })
    );
    for await (const event of loop) {
      if (event.type === "tool_execution_end" && event.isError) {
        errorEvents.push(
          (event.result as { content: Array<{ text: string }> }).content[0]?.text ?? ""
        );
      }
    }
    const messages = await loop.result();
    const lastAssistant = [...messages].reverse().find((message) => message?.role === "assistant");
    expect(lastAssistant).toMatchObject({ stopReason: "stop" });
    expect(errorEvents.join(" ")).toContain("KNOWLEDGE_READ_BEFORE_SEARCH");
  });

  it("rejects an invalid run question at tool construction", async () => {
    const { spaceId, spaceRoot } = await compiledSpace();
    expect(() =>
      createKnowledgeTools(componentOver(spaceId, spaceRoot), { question: " " })
    ).toThrow("KNOWLEDGE_SEARCH_QUESTION_INVALID");
  });
});

describe("finalizeGroundedAnswer", () => {
  async function bundleWithIds(): Promise<{ evidence: EvidenceBundleT; ids: string[] }> {
    const { spaceId, spaceRoot } = await compiledSpace();
    const component = componentOver(spaceId, spaceRoot);
    const evidence = await component.search({ question: "间隔检索" });
    return { evidence, ids: evidence.items.map(({ id }) => id) };
  }

  it("accepts a valid generated answer citing bundle evidence", async () => {
    const { evidence, ids } = await bundleWithIds();
    const result = finalizeGroundedAnswer(
      JSON.stringify({
        answer: "应每天练习。",
        evidenceIds: ids,
        insufficientEvidence: false,
        mode: "generated"
      }),
      evidence
    );
    expect(result.answer).toMatchObject({ mode: "generated", insufficientEvidence: false });
    expect(result.evidence).toEqual(evidence);
  });

  it.each([
    {
      label: "non-JSON output",
      output: "应该每天练习。"
    },
    {
      label: "a forged evidence id",
      output: JSON.stringify({
        answer: "伪造引用。",
        evidenceIds: ["00000000-0000-4000-8000-000000000000__evidence-01"],
        insufficientEvidence: false,
        mode: "generated"
      })
    },
    {
      label: "insufficient evidence that still cites",
      output: JSON.stringify({
        answer: "依据不足。",
        evidenceIds: ["placeholder"],
        insufficientEvidence: true,
        mode: "generated"
      })
    },
    {
      label: "a non-generated mode",
      output: JSON.stringify({
        answer: "模式错误。",
        evidenceIds: [],
        insufficientEvidence: true,
        mode: "extractive_fallback"
      })
    }
  ])("degrades $label to the honest extractive fallback", async ({ output }) => {
    const { evidence } = await bundleWithIds();
    const result = finalizeGroundedAnswer(output, evidence);
    expect(result.answer.mode).toBe("extractive_fallback");
    expect(result.evidence).toEqual(evidence);
  });

  it("degrades a missing model output and keeps the empty-bundle refusal", async () => {
    const { evidence, ids } = await bundleWithIds();
    expect(finalizeGroundedAnswer(null, evidence).answer.mode).toBe("extractive_fallback");
    const empty = { ...evidence, items: [], searchedPages: 0 };
    const refused = finalizeGroundedAnswer(null, empty);
    expect(refused.answer).toMatchObject({
      insufficientEvidence: true,
      mode: "extractive_fallback"
    });
    void ids;
  });
});
