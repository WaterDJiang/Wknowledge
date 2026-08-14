import { createSkillRunInputSchema } from "@wknowledge/contracts";
import {
  createQueuedSkillRun,
  getAgentSessionDetail,
  listSessionSkillRuns
} from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";
import { getManagedSkill } from "../../../../../lib/settings";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { sessionId } = await context.params;
  try {
    return Response.json({ runs: await listSessionSkillRuns(sessionId, user.id) });
  } catch (error) {
    if (error instanceof Error && error.message === "AGENT_SESSION_NOT_FOUND")
      return apiError(404, "AGENT_SESSION_NOT_FOUND", "会话不存在或无权访问");
    return apiError(503, "SKILL_RUNS_UNAVAILABLE", "Skill 运行记录暂时无法读取，请稍后重试");
  }
}

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(request, user.id, "skill_run.create", {
    limit: 20,
    windowSeconds: 60
  });
  if (securityError) return securityError;
  const parsed = createSkillRunInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(
      400,
      "INPUT_INVALID",
      "Skill 运行请求不正确",
      undefined,
      parsed.error.flatten()
    );
  const { sessionId } = await context.params;
  try {
    const detail = await getAgentSessionDetail(sessionId, user.id);
    const skill = await getManagedSkill(detail.session.organizationId, parsed.data.skillId);
    if (!skill) return apiError(404, "SKILL_NOT_FOUND", "Skill 不存在");
    if (skill.id === "plan-compose" || skill.id === "practice-generate")
      return apiError(
        409,
        "LEARNING_GENERATION_REQUEST_REQUIRED",
        "计划生成必须从学习内容页选择资料和目标后发起"
      );
    const run = await createQueuedSkillRun({ sessionId, userId: user.id, skill, ...parsed.data });
    return Response.json({ run }, { status: 202 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "SKILL_RUN_CREATE_FAILED";
    if (code === "AGENT_SESSION_NOT_FOUND") return apiError(404, code, "会话不存在或无权访问");
    if (code === "AGENT_SESSION_ARCHIVED") return apiError(409, code, "归档会话不能运行 Skill");
    if (code === "SKILL_POLICY_DENIED") return apiError(403, code, "此 Skill 当前不允许运行");
    if (code === "SKILL_EXECUTION_UNAVAILABLE")
      return apiError(
        409,
        code,
        "此 Skill 尚未接入安全执行器",
        "当前仅支持会话内置问答和已标记为 Worker 只读的能力"
      );
    if (code === "SKILL_APPROVAL_REQUIRED")
      return apiError(409, code, "此 Skill 需要匹配当前版本、范围且未过期的批准");
    return apiError(500, "SKILL_RUN_CREATE_FAILED", "创建 Skill 运行失败，请稍后重试");
  }
}
