import { createSkillApprovalInputSchema } from "@wknowledge/contracts";
import { getAgentSessionDetail, requestSkillApproval } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";
import { getManagedSkill } from "../../../../../lib/settings";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "skill_approval.request",
    {
      limit: 20,
      windowSeconds: 60
    }
  );
  if (securityError) return securityError;
  const parsed = createSkillApprovalInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(
      400,
      "INPUT_INVALID",
      "Skill 审批请求不正确",
      undefined,
      parsed.error.flatten()
    );
  const { sessionId } = await context.params;
  try {
    const detail = await getAgentSessionDetail(sessionId, user.id);
    const skill = await getManagedSkill(detail.session.organizationId, parsed.data.skillId);
    if (!skill) return apiError(404, "SKILL_NOT_FOUND", "Skill 不存在");
    const approval = await requestSkillApproval({
      sessionId,
      userId: user.id,
      skill,
      bindingIds: parsed.data.bindingIds,
      inputSummary: parsed.data.inputSummary
    });
    return Response.json({ approval }, { status: 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "SKILL_APPROVAL_CREATE_FAILED";
    if (code === "AGENT_SESSION_NOT_FOUND") return apiError(404, code, "会话不存在或无权访问");
    if (code === "AGENT_SESSION_ARCHIVED") return apiError(409, code, "归档会话不能请求 Skill");
    if (code === "SKILL_POLICY_DENIED") return apiError(403, code, "此 Skill 当前不允许请求");
    if (code === "SKILL_APPROVAL_NOT_REQUIRED")
      return apiError(409, code, "此 Skill 当前不需要人工确认");
    return apiError(500, "SKILL_APPROVAL_CREATE_FAILED", "创建 Skill 审批失败，请稍后重试");
  }
}
