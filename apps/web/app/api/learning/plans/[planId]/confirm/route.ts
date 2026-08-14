import { confirmLearningPlan } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../../lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ planId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "learning_plan.confirm",
    {
      limit: 20,
      windowSeconds: 60
    }
  );
  if (securityError) return securityError;
  try {
    const plan = await confirmLearningPlan({
      planId: (await context.params).planId,
      userId: user.id
    });
    return Response.json({ plan });
  } catch (error) {
    const code = error instanceof Error ? error.message : "LEARNING_PLAN_CONFIRM_FAILED";
    if (code === "LEARNING_PLAN_NOT_FOUND") return apiError(404, code, "学习计划不存在或无权访问");
    if (code === "LEARNING_PLAN_NOT_DRAFT") return apiError(409, code, "只有草稿计划可以确认");
    if (code === "LEARNING_PLAN_SELECTION_REVOKED")
      return apiError(409, code, "所选资料已不可学习，请调整后重新创建计划");
    return apiError(500, "LEARNING_PLAN_CONFIRM_FAILED", "确认学习计划失败，请稍后重试");
  }
}
