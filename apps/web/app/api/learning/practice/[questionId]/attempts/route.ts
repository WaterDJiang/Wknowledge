import { submitPracticeAttemptInputSchema } from "@wknowledge/contracts";
import { submitPracticeAttempt } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../../lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ questionId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "practice.attempt.submit",
    { limit: 40, windowSeconds: 60 }
  );
  if (securityError) return securityError;
  const parsed = submitPracticeAttemptInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "练习答案不正确", undefined, parsed.error.flatten());
  try {
    return Response.json(
      {
        attempt: await submitPracticeAttempt({
          ...parsed.data,
          questionId: (await context.params).questionId,
          userId: user.id
        })
      },
      { status: 201 }
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "PRACTICE_ATTEMPT_UNAVAILABLE";
    if (code === "LEARNING_PLAN_ACTIVE_NOT_FOUND")
      return apiError(409, code, "请先确认一个学习计划");
    if (code === "LEARNING_COURSE_ACTIVE_NOT_FOUND")
      return apiError(409, code, "当前计划尚未完成课程编排，请重新生成计划");
    if (code === "PRACTICE_QUESTION_NOT_FOUND")
      return apiError(404, code, "练习题不存在、已归档或无权访问");
    if (code === "PRACTICE_ATTEMPT_SOURCE_REVOKED")
      return apiError(409, code, "原文资料已不可学习，无法提交新的作答");
    return apiError(503, "PRACTICE_ATTEMPT_UNAVAILABLE", "练习答案暂时无法保存，请稍后重试");
  }
}
