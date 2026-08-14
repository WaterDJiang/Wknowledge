import { createAgentContextBindingInputSchema } from "@wknowledge/contracts";
import { addAgentSessionContextBinding } from "@wknowledge/core";
import { getWikiPage } from "@wknowledge/wiki";
import path from "node:path";
import { apiError, currentUser, dataRoot } from "../../../../../lib/api";
import { presentAgentContextBinding } from "../../../../../lib/agent-sessions";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "agent_context.create"
  );
  if (securityError) return securityError;
  const parsed = createAgentContextBindingInputSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "知识空间标识不正确", undefined, parsed.error.flatten());
  try {
    const binding = await addAgentSessionContextBinding({
      sessionId: (await context.params).sessionId,
      userId: user.id,
      ...parsed.data,
      resolveWikiPage: async ({ spaceId, pageId }) => {
        const page = await getWikiPage(path.join(dataRoot(), spaceId), pageId);
        return page ? { title: page.title } : null;
      }
    });
    return Response.json({ binding: presentAgentContextBinding(binding) }, { status: 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "AGENT_CONTEXT_CREATE_FAILED";
    if (code === "AGENT_SESSION_NOT_FOUND") return apiError(404, code, "会话不存在或无权访问");
    if (code === "AGENT_SESSION_ARCHIVED")
      return apiError(409, code, "归档会话不能添加知识范围", "请先恢复会话");
    if (code === "AGENT_CONTEXT_SPACE_DENIED")
      return apiError(403, code, "无权将该知识空间添加到会话");
    if (code === "AGENT_CONTEXT_ORGANIZATION_MISMATCH")
      return apiError(400, code, "一个会话只能绑定同一组织内的知识空间");
    if (code === "AGENT_CONTEXT_ALREADY_BOUND")
      return apiError(409, code, "该知识范围已在当前会话中");
    if (code === "AGENT_CONTEXT_TARGET_NOT_FOUND" || code === "AGENT_CONTEXT_TARGET_UNAVAILABLE")
      return apiError(404, code, "指定的知识页面、资料版本或学习课程不可用");
    if (code === "AGENT_CONTEXT_LIMIT_EXCEEDED")
      return apiError(409, code, "一个会话最多可绑定 8 个知识空间");
    return apiError(500, "AGENT_CONTEXT_CREATE_FAILED", "添加知识范围失败，请稍后重试");
  }
}
