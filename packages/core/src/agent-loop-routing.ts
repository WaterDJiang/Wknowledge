import { getDatabase, schema } from "@wknowledge/database";
import type { GroundedQueryResult } from "@wknowledge/contracts";

/**
 * S7 migration groundwork: which loop served each turn (audit-countable, so
 * the "old-path calls stay zero across two observation windows" gate has a
 * truth source) and a structured old-vs-new turn comparison for the bypass
 * equivalence report.
 */

export type AgentLoopKind = "internal" | "pi";

export async function recordAgentLoopRouting(input: {
  organizationId: string;
  sessionId: string;
  runId: string;
  userId?: string;
  loop: AgentLoopKind;
}): Promise<void> {
  if (input.loop !== "internal" && input.loop !== "pi") {
    throw new Error("AGENT_LOOP_KIND_INVALID");
  }
  await getDatabase()
    .insert(schema.auditEvents)
    .values({
      organizationId: input.organizationId,
      ...(input.userId !== undefined ? { actorUserId: input.userId } : {}),
      action: "agent_loop.routing",
      targetType: "agent_run",
      targetId: input.runId,
      metadata: { loop: input.loop, sessionId: input.sessionId }
    });
}

export interface AgentTurnDiff {
  answerEqual: boolean;
  evidenceIdsEqual: boolean;
  modeEqual: boolean;
  equivalent: boolean;
  differences: string[];
}

export function diffAgentTurnResults(
  internal: GroundedQueryResult,
  pi: GroundedQueryResult
): AgentTurnDiff {
  const differences: string[] = [];
  if (internal.answer.answer !== pi.answer.answer) differences.push("answer");
  if (internal.answer.mode !== pi.answer.mode) differences.push("mode");
  if (
    JSON.stringify(internal.evidence.items.map(({ id }) => id)) !==
    JSON.stringify(pi.evidence.items.map(({ id }) => id))
  ) {
    differences.push("evidenceIds");
  }
  if (internal.answer.insufficientEvidence !== pi.answer.insufficientEvidence) {
    differences.push("insufficientEvidence");
  }
  return {
    answerEqual: !differences.includes("answer"),
    evidenceIdsEqual: !differences.includes("evidenceIds"),
    modeEqual: !differences.includes("mode"),
    equivalent: differences.length === 0,
    differences
  };
}
