import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelGateway, ModelResponse } from "@wknowledge/model-gateway";
import { compileWiki, initializeSpace } from "@wknowledge/wiki";
import {
  createBoundKnowledgeComponent,
  runBoundKnowledgeAgent,
  runPiKnowledgeTurn,
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

function gatewayWith(responses: ModelResponse[]): ModelGateway {
  return {
    invoke() {
      const response = responses.shift();
      if (!response) return Promise.reject(new Error("MODEL_GATEWAY_EXHAUSTED"));
      return Promise.resolve(response);
    }
  } as unknown as ModelGateway;
}

function textResponse(text: string): ModelResponse {
  return { providerId: "provider-1", model: "model-1", durationMs: 1, output: text };
}

function toolCallResponse(id: string, name: string, argumentsJson: string): ModelResponse {
  return {
    providerId: "provider-1",
    model: "model-1",
    durationMs: 1,
    output: { type: "tool_calls", toolCalls: [{ id, name, arguments: argumentsJson }] }
  };
}

async function compiledSpace(): Promise<{
  component: KnowledgeComponent;
  spaceId: string;
  spaceRoot: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "wknowledge-pi-loop-"));
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
  const component = createBoundKnowledgeComponent({
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
  return { component, spaceId, spaceRoot };
}

describe("runPiKnowledgeTurn production loop", () => {
  it("returns the same grounded turn as the internal loop on identical scripted turns", async () => {
    const { component, spaceId, spaceRoot } = await compiledSpace();
    const question = "间隔检索";

    const probe = await component.search({ question });
    const evidenceIds = probe.items.map(({ id }) => id);
    expect(evidenceIds.length).toBeGreaterThan(0);
    const answer = JSON.stringify({
      answer: "应每天练习。",
      evidenceIds,
      insufficientEvidence: false,
      mode: "generated"
    });
    const scriptedTurn = (): ModelResponse[] => [
      toolCallResponse("call-search", "knowledge.search", "{}"),
      toolCallResponse("call-read", "knowledge.read", JSON.stringify({ evidenceIds })),
      textResponse(answer)
    ];

    const internal = await runBoundKnowledgeAgent(
      randomUUID(),
      [{ bindingId: "binding", spaceId, spaceRoot }],
      question,
      { gateway: gatewayWith(scriptedTurn()), dataPolicy: "local_only", enableToolLoop: true }
    );
    expect(internal.modelCall).toMatchObject({ status: "succeeded" });

    const piTurn = await runPiKnowledgeTurn({
      runId: "run-pi-turn",
      component,
      gateway: gatewayWith(scriptedTurn()),
      dataPolicy: "local_only",
      question,
      policy: allowAll
    });

    expect(piTurn.result).toEqual(internal.result);
    expect(piTurn.modelCall).toMatchObject({ status: "succeeded", providerId: "provider-1" });
    expect(piTurn.events.map((event) => event.type)).toEqual([
      "run.started",
      "tool.requested",
      "tool.completed",
      "tool.requested",
      "tool.completed",
      "assistant.delta",
      "run.completed"
    ]);
    expect(piTurn.events.at(-1)).toEqual({ type: "run.completed", runId: "run-pi-turn" });
  });

  it("degrades honestly without a gateway and on an empty bundle", async () => {
    const { component } = await compiledSpace();
    const noGateway = await runPiKnowledgeTurn({
      runId: "run-a",
      component,
      gateway: null,
      dataPolicy: "local_only",
      question: "间隔检索",
      policy: allowAll
    });
    expect(noGateway.result.answer.mode).toBe("extractive_fallback");
    expect(noGateway.modelCall).toBeNull();
    expect(noGateway.events.at(-1)).toMatchObject({ type: "run.completed" });

    const emptyBundle = await runPiKnowledgeTurn({
      runId: "run-b",
      component,
      gateway: gatewayWith([]),
      dataPolicy: "local_only",
      question: "怎样做好红烧肉？",
      policy: allowAll
    });
    expect(emptyBundle.result.answer).toMatchObject({
      insufficientEvidence: true,
      mode: "extractive_fallback"
    });
    expect(emptyBundle.modelCall).toBeNull();
  });

  it("folds a budget rejection into a failed terminal and a grounded fallback", async () => {
    const { component } = await compiledSpace();
    const failing: ModelGateway = {
      invoke: () => Promise.reject(new Error("MODEL_BUDGET_EXCEEDED"))
    } as unknown as ModelGateway;
    const turn = await runPiKnowledgeTurn({
      runId: "run-budget",
      component,
      gateway: failing,
      dataPolicy: "local_only",
      question: "间隔检索",
      policy: allowAll
    });
    expect(turn.events.at(-1)).toEqual({
      type: "run.failed",
      runId: "run-budget",
      code: "MODEL_BUDGET_EXCEEDED"
    });
    expect(turn.modelCall).toMatchObject({ status: "failed", errorCode: "MODEL_BUDGET_EXCEEDED" });
    expect(turn.result.answer.mode).toBe("extractive_fallback");
  });

  it("honors a policy denial inside the production loop", async () => {
    const { component } = await compiledSpace();
    const probe = await component.search({ question: "间隔检索" });
    const evidenceIds = probe.items.map(({ id }) => id);
    const answer = JSON.stringify({
      answer: "工具被拒绝后的回答。",
      evidenceIds,
      insufficientEvidence: false,
      mode: "generated"
    });
    const denying: AgentToolPolicyBridge = {
      async beforeToolCall() {
        return { allow: false, code: "AGENT_TOOL_REVOKED" };
      },
      async afterToolCall() {
        return {};
      }
    };
    const turn = await runPiKnowledgeTurn({
      runId: "run-denied",
      component,
      gateway: gatewayWith([
        toolCallResponse("call-search", "knowledge.search", "{}"),
        textResponse(answer)
      ]),
      dataPolicy: "local_only",
      question: "间隔检索",
      policy: denying
    });
    expect(turn.events.map((event) => event.type)).toEqual([
      "run.started",
      "tool.requested",
      "tool.completed",
      "assistant.delta",
      "run.completed"
    ]);
    expect(turn.result.answer.mode).toBe("generated");
  });
});
