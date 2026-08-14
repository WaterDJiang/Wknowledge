import { getManagedOrganization } from "@wknowledge/auth";
import { updateUserDisabledInputSchema } from "@wknowledge/contracts";
import { setOrganizationUserDisabled } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const organization = await getManagedOrganization(user.id);
  if (!organization) return apiError(403, "ORG_ADMIN_REQUIRED", "只有组织管理员可以管理用户");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "settings.user.update"
  );
  if (securityError) return securityError;
  const parsed = updateUserDisabledInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "用户状态不正确", undefined, parsed.error.flatten());
  const { userId } = await context.params;
  try {
    const updated = await setOrganizationUserDisabled({
      organizationId: organization.organizationId,
      userId,
      actorUserId: user.id,
      disabled: parsed.data.disabled
    });
    return Response.json({ user: updated });
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "ORGANIZATION_USER_NOT_FOUND") return apiError(404, code, "组织用户不存在");
    if (code === "USER_SELF_DISABLE_FORBIDDEN" || code === "OWNER_DISABLE_FORBIDDEN")
      return apiError(409, code, "不能禁用该用户");
    return apiError(500, "USER_STATUS_UPDATE_FAILED", "用户状态更新失败", "刷新后重试");
  }
}
