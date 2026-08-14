import {
  getAgentSessionDetail,
  listSessionSkillApprovals,
  listSessionSkillPolicies
} from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../lib/api";
import { listManagedSkills } from "../../../../../lib/settings";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { sessionId } = await context.params;
  try {
    const detail = await getAgentSessionDetail(sessionId, user.id);
    const [skills, approvals] = await Promise.all([
      listManagedSkills(detail.session.organizationId),
      listSessionSkillApprovals({ sessionId, userId: user.id })
    ]);
    return Response.json({
      skills: await listSessionSkillPolicies({ sessionId, userId: user.id, skills }),
      approvals
    });
  } catch (error) {
    if (error instanceof Error && error.message === "AGENT_SESSION_NOT_FOUND")
      return apiError(404, "AGENT_SESSION_NOT_FOUND", "会话不存在或无权访问");
    return apiError(500, "SESSION_SKILLS_READ_FAILED", "Skill 状态读取失败，请稍后重试");
  }
}
