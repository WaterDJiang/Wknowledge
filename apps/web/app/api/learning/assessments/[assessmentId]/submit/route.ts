import { submitAssessment } from "@wknowledge/core";
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
  const securityError = await enforceAuthenticatedMutation(request, user.id, "assessment.submit", {
    limit: 20,
    windowSeconds: 60
  });
  if (securityError) return securityError;
  try {
    return Response.json({
      assessment: await submitAssessment({
        assessmentId: (await context.params).assessmentId,
        userId: user.id
      })
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "ASSESSMENT_UNAVAILABLE";
    if (code === "ASSESSMENT_NOT_FOUND") return apiError(404, code, "正式测评不存在或无权访问");
    if (code === "ASSESSMENT_NOT_ACTIVE") return apiError(409, code, "请先开始未提交的正式测评");
    if (code === "ASSESSMENT_ATTEMPTS_INCOMPLETE")
      return apiError(409, code, "请完成所有题目后再提交正式测评");
    if (code === "ASSESSMENT_SUBMIT_CONFLICT")
      return apiError(409, code, "测评状态已变化，请刷新后重试");
    return presentAssessmentError(error);
  }
}
