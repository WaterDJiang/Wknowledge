import { getManagedOrganization } from "@wknowledge/auth";
import { revokeOrganizationInvitation } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ invitationId: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const organization = await getManagedOrganization(user.id);
  if (!organization) return apiError(403, "ORG_ADMIN_REQUIRED", "只有组织管理员可以撤销邀请");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "settings.invitation.revoke"
  );
  if (securityError) return securityError;
  const { invitationId } = await context.params;
  try {
    await revokeOrganizationInvitation({
      organizationId: organization.organizationId,
      invitationId,
      actorUserId: user.id
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "INVITATION_NOT_REVOCABLE")
      return apiError(409, code, "邀请已接受、已撤销或不存在");
    return apiError(500, "INVITATION_REVOKE_FAILED", "邀请撤销失败", "刷新后重试");
  }
}
