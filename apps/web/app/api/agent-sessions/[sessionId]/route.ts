import { updateAgentSessionInputSchema } from "@wknowledge/contracts";
import { getAgentSessionDetail, updateAgentSession } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../lib/api";
import {
  presentAgentContextBinding,
  presentAgentEvidenceSnapshot,
  presentAgentKnowledgeToolCall,
  presentAgentMessage,
  presentAgentRun,
  presentAgentSessionSummary
} from "../../../../lib/agent-sessions";
import { enforceAuthenticatedMutation } from "../../../../lib/request-security";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  try {
    const detail = await getAgentSessionDetail((await context.params).sessionId, user.id);
    const evidenceByRun = new Map<string, ReturnType<typeof presentAgentEvidenceSnapshot>[]>();
    for (const snapshot of detail.snapshots) {
      const items = evidenceByRun.get(snapshot.agentRunId) ?? [];
      items.push(
        presentAgentEvidenceSnapshot({
          ...snapshot,
          pageType: snapshot.pageType as "concept" | "topic" | "case" | "course" | "material"
        })
      );
      evidenceByRun.set(snapshot.agentRunId, items);
    }
    return Response.json({
      session: presentAgentSessionSummary({
        session: detail.session,
        bindingCount: detail.bindings.filter(({ status }) => status === "active").length,
        lastMessageAt: detail.messages.at(-1)?.createdAt ?? null
      }),
      bindings: detail.bindings.map(presentAgentContextBinding),
      messages: detail.messages.map(presentAgentMessage),
      runs: detail.runs.map((run) =>
        presentAgentRun({ ...run, evidence: evidenceByRun.get(run.id) ?? [] })
      ),
      toolCalls: detail.toolCalls.map(presentAgentKnowledgeToolCall)
    });
  } catch (error) {
    if (error instanceof Error && error.message === "AGENT_SESSION_NOT_FOUND")
      return apiError(404, "AGENT_SESSION_NOT_FOUND", "会话不存在或无权访问");
    if (error instanceof Error && error.message === "AGENT_SESSION_ACCESS_REVOKED")
      return apiError(
        403,
        "AGENT_SESSION_ACCESS_REVOKED",
        "会话包含已撤销知识范围，历史内容已停止访问",
        "恢复相应知识空间权限，或新建仅包含当前可访问资料的会话"
      );
    return apiError(500, "AGENT_SESSION_READ_FAILED", "会话读取失败，请稍后重试");
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "agent_session.update"
  );
  if (securityError) return securityError;
  const parsed = updateAgentSessionInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || (!parsed.data.title && !parsed.data.status))
    return apiError(400, "INPUT_INVALID", "会话更新内容不正确");
  try {
    const session = await updateAgentSession(
      (await context.params).sessionId,
      user.id,
      parsed.data
    );
    return Response.json({ session });
  } catch (error) {
    if (error instanceof Error && error.message === "AGENT_SESSION_NOT_FOUND")
      return apiError(404, "AGENT_SESSION_NOT_FOUND", "会话不存在或无权访问");
    return apiError(500, "AGENT_SESSION_UPDATE_FAILED", "更新会话失败，请稍后重试");
  }
}
