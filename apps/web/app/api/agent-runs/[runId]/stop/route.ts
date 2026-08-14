import { stopAgentSessionRun } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../lib/api";
import { stopActiveAgentRunStream } from "../../../../../lib/agent-run-stream";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(request, user.id, "agent_run.stop", {
    limit: 30,
    windowSeconds: 60
  });
  if (securityError) return securityError;
  const { runId } = await context.params;
  try {
    const durationMs = stopActiveAgentRunStream(runId, user.id) ?? 0;
    const run = await stopAgentSessionRun({ runId, userId: user.id, durationMs });
    return Response.json({ run });
  } catch (error) {
    const code = error instanceof Error ? error.message : "AGENT_RUN_STOP_FAILED";
    if (code === "AGENT_RUN_NOT_FOUND") return apiError(404, code, "运行不存在或无权停止");
    return apiError(500, "AGENT_RUN_STOP_FAILED", "停止对话失败，请稍后重试");
  }
}
