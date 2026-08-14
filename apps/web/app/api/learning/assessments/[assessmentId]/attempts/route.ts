import { submitAssessmentAttemptInputSchema } from "@wknowledge/contracts";
import { submitAssessmentAttempt } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../../lib/request-security";
import { presentAssessmentError } from "../../assessment-error";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ assessmentId: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "assessment.attempt.submit",
    { limit: 40, windowSeconds: 60 }
  );
  if (securityError) return securityError;
  const parsed = submitAssessmentAttemptInputSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "测评答案不正确", undefined, parsed.error.flatten());
  try {
    return Response.json(
      {
        attempt: await submitAssessmentAttempt({
          ...parsed.data,
          assessmentId: (await context.params).assessmentId,
          userId: user.id
        })
      },
      { status: 201 }
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "ASSESSMENT_ATTEMPT_UNAVAILABLE";
    if (code === "ASSESSMENT_NOT_FOUND") return apiError(404, code, "正式测评不存在或无权访问");
    if (code === "ASSESSMENT_NOT_ACTIVE") return apiError(409, code, "请先开始未提交的正式测评");
    if (code === "ASSESSMENT_QUESTION_NOT_FOUND")
      return apiError(404, code, "测评题不存在或不属于该题卷");
    if (code === "ASSESSMENT_QUESTION_ALREADY_ANSWERED")
      return apiError(409, code, "正式测评每道题仅可提交一次");
    if (code === "ASSESSMENT_QUESTION_ANSWER_KEY_MISSING")
      return apiError(409, code, "客观题缺少受管答案键，无法判定");
    return presentAssessmentError(error);
  }
}
