import { decideSkillApprovalInputSchema } from "@wknowledge/contracts";
import { decideSkillApproval } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ approvalId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "skill_approval.decide",
    {
      limit: 20,
      windowSeconds: 60
    }
  );
  if (securityError) return securityError;
  const parsed = decideSkillApprovalInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INPUT_INVALID", "审批决定不正确");
  try {
    const approval = await decideSkillApproval({
      approvalId: (await context.params).approvalId,
      userId: user.id,
      decision: parsed.data.decision
    });
    return Response.json({ approval });
  } catch (error) {
    const code = error instanceof Error ? error.message : "SKILL_APPROVAL_DECISION_FAILED";
    if (code === "SKILL_APPROVAL_NOT_FOUND") return apiError(404, code, "审批不存在或无权访问");
    if (code === "SKILL_APPROVAL_EXPIRED") return apiError(409, code, "审批已过期，需要重新请求");
    if (code === "SKILL_APPROVAL_SCOPE_REVOKED")
      return apiError(409, code, "知识范围已变更或撤权，需要重新请求");
    if (code === "SKILL_APPROVAL_ALREADY_DECIDED")
      return apiError(409, code, "审批已经处理，不能重写历史");
    if (code === "AGENT_SESSION_ARCHIVED")
      return apiError(409, code, "归档会话不能处理 Skill 审批");
    return apiError(500, "SKILL_APPROVAL_DECISION_FAILED", "处理 Skill 审批失败，请稍后重试");
  }
}
