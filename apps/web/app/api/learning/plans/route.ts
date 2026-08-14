import { createLearningPlanInputSchema } from "@wknowledge/contracts";
import { createLearningPlanDraft, listLearningPlans } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../lib/request-security";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  return Response.json({ plans: await listLearningPlans(user.id) });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "learning_plan.create",
    {
      limit: 20,
      windowSeconds: 60
    }
  );
  if (securityError) return securityError;
  const parsed = createLearningPlanInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "学习计划内容不正确", undefined, parsed.error.flatten());
  try {
    return Response.json(
      { plan: await createLearningPlanDraft({ ...parsed.data, userId: user.id }) },
      { status: 201 }
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "LEARNING_PLAN_CREATE_FAILED";
    if (code === "LEARNING_PLAN_SELECTION_DUPLICATE")
      return apiError(400, code, "学习内容不能重复选择");
    if (code === "LEARNING_PLAN_SELECTION_DENIED")
      return apiError(403, code, "所选资料不存在、未完成处理或无权学习");
    return apiError(500, "LEARNING_PLAN_CREATE_FAILED", "创建学习计划失败，请稍后重试");
  }
}
