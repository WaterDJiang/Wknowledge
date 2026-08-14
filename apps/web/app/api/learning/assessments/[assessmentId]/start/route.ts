import { startAssessment } from "@wknowledge/core";
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
  const securityError = await enforceAuthenticatedMutation(request, user.id, "assessment.start", {
    limit: 20,
    windowSeconds: 60
  });
  if (securityError) return securityError;
  try {
    return Response.json(
      {
        assessment: await startAssessment({
          assessmentId: (await context.params).assessmentId,
          userId: user.id
        })
      },
      { status: 200 }
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "ASSESSMENT_UNAVAILABLE";
    if (code === "ASSESSMENT_NOT_FOUND") return apiError(404, code, "正式测评不存在或无权访问");
    if (code === "ASSESSMENT_ALREADY_SUBMITTED")
      return apiError(409, code, "正式测评已提交，不能重新开始");
    return presentAssessmentError(error);
  }
}
