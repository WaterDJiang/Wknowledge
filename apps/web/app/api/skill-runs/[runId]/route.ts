import { getSkillRun } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../lib/api";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  try {
    return Response.json({ run: await getSkillRun((await context.params).runId, user.id) });
  } catch (error) {
    if (error instanceof Error && error.message === "SKILL_RUN_NOT_FOUND")
      return apiError(404, "SKILL_RUN_NOT_FOUND", "Skill 运行不存在或无权访问");
    return apiError(503, "SKILL_RUN_UNAVAILABLE", "Skill 运行状态暂时无法读取，请稍后重试");
  }
}
