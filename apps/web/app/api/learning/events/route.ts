import { learningEventInputSchema } from "@wknowledge/contracts";
import { recordActiveLearningEvent } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "learning_event.record",
    {
      limit: 120,
      windowSeconds: 60
    }
  );
  if (securityError) return securityError;
  const parsed = learningEventInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "学习记录内容不正确", undefined, parsed.error.flatten());
  try {
    return Response.json({
      units: await recordActiveLearningEvent({ ...parsed.data, userId: user.id })
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "LEARNING_EVENT_CREATE_FAILED";
    if (code === "LEARNING_PLAN_ACTIVE_NOT_FOUND")
      return apiError(409, code, "请先确认一个学习计划");
    if (code === "LEARNING_UNIT_SOURCE_DENIED")
      return apiError(403, code, "该学习单元或来源不属于当前计划");
    if (code === "LEARNING_UNIT_SOURCE_REVOKED")
      return apiError(409, code, "该资料已不可学习，请联系空间管理员");
    return apiError(500, "LEARNING_EVENT_CREATE_FAILED", "学习记录保存失败，请稍后重试");
  }
}
