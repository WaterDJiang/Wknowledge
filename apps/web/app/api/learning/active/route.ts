import { getActiveLearningPlan, getActiveLearningProgress } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../lib/api";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  try {
    const plan = await getActiveLearningPlan(user.id);
    return Response.json({ plan, units: await getActiveLearningProgress(user.id) });
  } catch (error) {
    if (error instanceof Error && error.message === "LEARNING_PLAN_ACTIVE_NOT_FOUND")
      return apiError(404, "LEARNING_PLAN_ACTIVE_NOT_FOUND", "尚未确认学习计划");
    return apiError(503, "LEARNING_ACTIVE_UNAVAILABLE", "学习状态暂时无法读取，请稍后重试");
  }
}
