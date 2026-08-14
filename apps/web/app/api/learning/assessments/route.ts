import { createAssessmentInputSchema } from "@wknowledge/contracts";
import { createAssessment, listAssessments } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../lib/request-security";
import { presentAssessmentError } from "./assessment-error";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  try {
    return Response.json({ assessments: await listAssessments(user.id) });
  } catch (error) {
    return presentAssessmentError(error);
  }
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(request, user.id, "assessment.create", {
    limit: 20,
    windowSeconds: 60
  });
  if (securityError) return securityError;
  const parsed = createAssessmentInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "正式测评内容不正确", undefined, parsed.error.flatten());
  try {
    return Response.json(
      { assessment: await createAssessment({ ...parsed.data, userId: user.id }) },
      { status: 201 }
    );
  } catch (error) {
    return presentAssessmentError(error);
  }
}
