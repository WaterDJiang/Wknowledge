import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import {
  beginAgentSessionRun,
  createAgentSession,
  getAgentRunEvents,
  persistAgentCoreEventProjection
} from "../src/index";
import type { AgentCoreEvent } from "@wknowledge/agent-runtime";

const test = process.env.DATABASE_URL ? it : it.skip;

async function fixture() {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  await db.insert(schema.organizations).values({ id: organizationId, name: "投影测试组织" });
  await db.insert(schema.users).values({
    id: userId,
    email: `projection-${userId}@example.com`,
    name: "投影用户",
    passwordHash: "not-used"
  });
  await db
    .insert(schema.organizationMemberships)
    .values({ organizationId, userId, role: "viewer" });
  await db
    .insert(schema.knowledgeSpaces)
    .values({ id: spaceId, organizationId, name: "投影空间", createdBy: userId });
  await db.insert(schema.spaceMemberships).values({ spaceId, userId, role: "viewer" });
  const session = await createAgentSession({
    userId,
    title: "投影会话",
    spaceIds: [spaceId]
  });
  return { db, userId, sessionId: session.id };
}

afterAll(async () => closeDatabase());

function piEventStream(runId: string): AgentCoreEvent[] {
  return [
    { type: "run.started", runId },
    { type: "assistant.delta", runId, text: "流式" },
    { type: "assistant.delta", runId, text: "正文不落库" },
    {
      type: "tool.requested",
      runId,
      toolCallId: "call-search",
      tool: "knowledge.search",
      inputSummary: "查询：间隔检索"
    },
    {
      type: "tool.completed",
      runId,
      toolCallId: "call-search",
      outputSummary: "2 条证据"
    },
    { type: "run.completed", runId }
  ];
}

describe("persistAgentCoreEventProjection", () => {
  test("projects a pi event stream for sse replay and settles the run", async () => {
    const { userId, sessionId } = await fixture();
    const { run } = await beginAgentSessionRun({ sessionId, userId, question: "间隔检索怎么做？" });
    const outcome = await persistAgentCoreEventProjection({
      runId: run.id,
      events: piEventStream(run.id)
    });
    expect(outcome).toEqual({ persisted: 3, terminal: "run.completed", errorCode: null });

    const events = await getAgentRunEvents({ runId: run.id, userId, afterSequence: 0 });
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "tool.requested",
      "tool.completed",
      "run.completed"
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events[1]).toMatchObject({
      tool: "knowledge.search",
      inputSummary: "查询：间隔检索"
    });
    expect(events[2]).toMatchObject({ tool: "knowledge.search", outputSummary: "2 条证据" });
    expect(JSON.stringify(events)).not.toContain("流式");

    await expect(
      persistAgentCoreEventProjection({ runId: run.id, events: piEventStream(run.id) })
    ).rejects.toThrow("AGENT_RUN_ALREADY_SETTLED");
  });

  test("settles a failed run with its stable error code", async () => {
    const { userId, sessionId } = await fixture();
    const { run } = await beginAgentSessionRun({ sessionId, userId, question: "失败场景" });
    const outcome = await persistAgentCoreEventProjection({
      runId: run.id,
      events: [
        { type: "run.started", runId: run.id },
        { type: "run.failed", runId: run.id, code: "MODEL_BUDGET_EXCEEDED" }
      ]
    });
    expect(outcome).toEqual({
      persisted: 1,
      terminal: "run.failed",
      errorCode: "MODEL_BUDGET_EXCEEDED"
    });
    const events = await getAgentRunEvents({ runId: run.id, userId, afterSequence: 0 });
    expect(events.at(-1)).toMatchObject({ type: "run.failed", status: "failed" });
  });

  test.each([
    { label: "missing run.started", events: (runId: string) => [{ type: "run.completed", runId }] },
    {
      label: "an unpersistable tool",
      events: (runId: string) => [
        { type: "run.started", runId },
        { type: "tool.requested", runId, toolCallId: "c1", tool: "shell.exec", inputSummary: "x" },
        { type: "tool.completed", runId, toolCallId: "c1", outputSummary: "y" },
        { type: "run.completed", runId }
      ]
    },
    {
      label: "an unfinished tool at terminal",
      events: (runId: string) => [
        { type: "run.started", runId },
        {
          type: "tool.requested",
          runId,
          toolCallId: "c1",
          tool: "knowledge.search",
          inputSummary: "x"
        },
        { type: "run.completed", runId }
      ]
    },
    {
      label: "a foreign run id",
      events: (runId: string) => [
        { type: "run.started", runId: `${runId}-foreign` },
        { type: "run.completed", runId: `${runId}-foreign` }
      ]
    }
  ])("rejects $label without partial writes", async ({ events }) => {
    const { userId, sessionId } = await fixture();
    const { run } = await beginAgentSessionRun({ sessionId, userId, question: "非法流" });
    await expect(
      persistAgentCoreEventProjection({ runId: run.id, events: events(run.id) as AgentCoreEvent[] })
    ).rejects.toThrow("AGENT_RUN_PROJECTION_INVALID");
    const afterEvents = await getAgentRunEvents({ runId: run.id, userId, afterSequence: 0 });
    expect(afterEvents.map((event) => event.type)).toEqual(["run.started"]);
  });

  test("rejects projection for an unknown run", async () => {
    const runId = randomUUID();
    await expect(
      persistAgentCoreEventProjection({
        runId,
        events: [
          { type: "run.started", runId },
          { type: "run.completed", runId }
        ]
      })
    ).rejects.toThrow("AGENT_RUN_NOT_FOUND");
  });
});
