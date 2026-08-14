import { createAgentSessionInputSchema, type AgentSessionSummary } from "@wknowledge/contracts";
import { createAgentSession, listAgentSessions } from "@wknowledge/core";
import { getWikiPage } from "@wknowledge/wiki";
import path from "node:path";
import { apiError, currentUser, dataRoot } from "../../../lib/api";
import { presentAgentSessionSummary } from "../../../lib/agent-sessions";
import { enforceAuthenticatedMutation } from "../../../lib/request-security";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const sessions = await listAgentSessions(user.id);
  return Response.json({
    sessions: sessions.map((value): AgentSessionSummary =>
      presentAgentSessionSummary({
        session: value,
        bindingCount: value.bindingCount,
        lastMessageAt: value.lastMessageAt
      })
    )
  });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "agent_session.create",
    {
      limit: 20,
      windowSeconds: 60
    }
  );
  if (securityError) return securityError;
  const parsed = createAgentSessionInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(
      400,
      "INPUT_INVALID",
      "会话标题或知识范围不正确",
      undefined,
      parsed.error.flatten()
    );
  try {
    const session = await createAgentSession({
      ...parsed.data,
      userId: user.id,
      resolveWikiPage: async ({ spaceId, pageId }) => {
        const page = await getWikiPage(path.join(dataRoot(), spaceId), pageId);
        return page ? { title: page.title } : null;
      }
    });
    return Response.json(
      {
        session: presentAgentSessionSummary({
          session: session,
          bindingCount: parsed.data.bindings.length,
          lastMessageAt: null
        })
      },
      { status: 201 }
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "AGENT_SESSION_CREATE_FAILED";
    if (code === "AGENT_CONTEXT_SPACE_DENIED")
      return apiError(403, code, "不能将无权知识空间添加到会话");
    if (code === "AGENT_CONTEXT_ORGANIZATION_MISMATCH")
      return apiError(400, code, "一个会话只能绑定同一组织内的知识空间");
    if (code === "AGENT_CONTEXT_TARGET_NOT_FOUND")
      return apiError(404, code, "指定的知识页面、资料版本或课程不存在或当前不可用");
    if (code === "AGENT_CONTEXT_ALREADY_BOUND")
      return apiError(409, code, "同一个知识范围不能重复加入会话");
    if (code === "AGENT_CONTEXT_LIMIT_EXCEEDED")
      return apiError(409, code, "一次会话最多可加入 8 个知识范围");
    return apiError(500, "AGENT_SESSION_CREATE_FAILED", "创建会话失败，请稍后重试");
  }
}
