import { updateLearnerDeclaredInputSchema } from "@wknowledge/contracts";
import { getLearnerProfile, updateLearnerDeclared } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../lib/request-security";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  try {
    return Response.json({ profile: await getLearnerProfile(user.id) });
  } catch {
    return apiError(503, "LEARNER_PROFILE_UNAVAILABLE", "学习画像暂时无法读取，请稍后重试");
  }
}

export async function PUT(request: Request) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "learner_profile.update",
    {
      limit: 20,
      windowSeconds: 60
    }
  );
  if (securityError) return securityError;
  const parsed = updateLearnerDeclaredInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "学习画像内容不正确", undefined, parsed.error.flatten());
  try {
    return Response.json({
      profile: await updateLearnerDeclared({ userId: user.id, declared: parsed.data })
    });
  } catch {
    return apiError(500, "LEARNER_PROFILE_UPDATE_FAILED", "学习画像保存失败，请稍后重试");
  }
}
