import { removeAgentSessionSpaceBinding } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../../lib/request-security";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ sessionId: string; bindingId: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "agent_context.remove"
  );
  if (securityError) return securityError;
  const { sessionId, bindingId } = await context.params;
  try {
    await removeAgentSessionSpaceBinding({ sessionId, bindingId, userId: user.id });
    return new Response(null, { status: 204 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "AGENT_CONTEXT_REMOVE_FAILED";
    if (code === "AGENT_SESSION_NOT_FOUND") return apiError(404, code, "会话不存在或无权访问");
    if (code === "AGENT_CONTEXT_BINDING_NOT_FOUND")
      return apiError(404, code, "知识范围不存在或已移除");
    return apiError(500, "AGENT_CONTEXT_REMOVE_FAILED", "移除知识范围失败，请稍后重试");
  }
}
