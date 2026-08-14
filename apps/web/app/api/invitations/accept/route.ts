import { acceptInvitationInputSchema } from "@wknowledge/contracts";
import { acceptOrganizationInvitation } from "@wknowledge/core";
import { apiError } from "../../../../lib/api";
import { enforcePublicMutation } from "../../../../lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = acceptInvitationInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "邀请接受信息不正确", undefined, parsed.error.flatten());
  const securityError = await enforcePublicMutation(request, "invitation.accept", "public", {
    limit: 10,
    windowSeconds: 600
  });
  if (securityError) return securityError;
  try {
    const result = await acceptOrganizationInvitation({
      token: parsed.data.token,
      name: parsed.data.name,
      ...(parsed.data.password ? { password: parsed.data.password } : {})
    });
    return Response.json({
      user: { id: result.user.id, email: result.user.email, name: result.user.name }
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "INVITATION_INVALID") return apiError(409, code, "邀请无效、已使用或已过期");
    if (code === "INVITATION_PASSWORD_REQUIRED")
      return apiError(400, code, "新用户必须设置至少 8 位密码");
    if (code === "INVITATION_USER_DISABLED") return apiError(409, code, "该账号已被禁用");
    return apiError(500, "INVITATION_ACCEPT_FAILED", "接受邀请失败", "请稍后重试");
  }
}
