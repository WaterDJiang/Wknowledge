import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import { diffAgentTurnResults, recordAgentLoopRouting } from "../src/index";
import type { GroundedQueryResult } from "@wknowledge/contracts";

const test = process.env.DATABASE_URL ? it : it.skip;

afterAll(async () => closeDatabase());

function turn(
  answer: string,
  evidenceIds: string[],
  mode: "generated" = "generated"
): GroundedQueryResult {
  return {
    answer: { answer, evidenceIds, insufficientEvidence: false, mode },
    evidence: {
      question: "q",
      items: evidenceIds.map((id, index) => ({
        id,
        pageId: `page-${index}`,
        pageTitle: "页面",
        pageType: "topic" as const,
        text: "证据",
        sourceRefs: ["wk://source/x"],
        conflicted: false
      })),
      searchedPages: 1,
      embeddingCalls: 0
    }
  };
}

describe("diffAgentTurnResults", () => {
  it("marks identical turns equivalent", () => {
    const diff = diffAgentTurnResults(turn("a", ["e1"]), turn("a", ["e1"]));
    expect(diff).toMatchObject({ equivalent: true, differences: [] });
  });

  it("reports each dimension of divergence", () => {
    const diff = diffAgentTurnResults(turn("a", ["e1"]), turn("b", ["e2"]));
    expect(diff.equivalent).toBe(false);
    expect(diff.differences).toEqual(["answer", "evidenceIds"]);
  });
});

describe("recordAgentLoopRouting", () => {
  test("appends an auditable routing record per run", async () => {
    const db = getDatabase();
    const organizationId = randomUUID();
    const userId = randomUUID();
    await db.insert(schema.organizations).values({ id: organizationId, name: "路由计数测试组织" });
    await db.insert(schema.users).values({
      id: userId,
      email: `routing-${userId}@example.com`,
      name: "路由用户",
      passwordHash: "not-used"
    });
    const runId = randomUUID();
    await recordAgentLoopRouting({
      organizationId,
      sessionId: randomUUID(),
      runId,
      userId,
      loop: "pi"
    });
    await recordAgentLoopRouting({
      organizationId,
      sessionId: randomUUID(),
      runId: randomUUID(),
      loop: "internal"
    });
    const rows = await db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.organizationId, organizationId),
          eq(schema.auditEvents.action, "agent_loop.routing")
        )
      );
    expect(rows.map((row) => (row.metadata as { loop: string }).loop).sort()).toEqual([
      "internal",
      "pi"
    ]);
    await expect(
      recordAgentLoopRouting({ organizationId, sessionId: "s", runId, loop: "other" as never })
    ).rejects.toThrow("AGENT_LOOP_KIND_INVALID");
    await db.delete(schema.organizations).where(eq(schema.organizations.id, organizationId));
  });
});
