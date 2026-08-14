import { getManagedOrganization } from "@wknowledge/auth";
import { createInvitationInputSchema } from "@wknowledge/contracts";
import { createOrganizationInvitation, listOrganizationInvitations } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../lib/request-security";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const organization = await getManagedOrganization(user.id);
  if (!organization) return apiError(403, "ORG_ADMIN_REQUIRED", "只有组织管理员可以管理邀请");
  return Response.json({
    invitations: await listOrganizationInvitations(organization.organizationId)
  });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const organization = await getManagedOrganization(user.id);
  if (!organization) return apiError(403, "ORG_ADMIN_REQUIRED", "只有组织管理员可以创建邀请");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "settings.invitation.create"
  );
  if (securityError) return securityError;
  const parsed = createInvitationInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "邀请信息不正确", undefined, parsed.error.flatten());
  try {
    const result = await createOrganizationInvitation({
      organizationId: organization.organizationId,
      invitedBy: user.id,
      email: parsed.data.email,
      organizationRole: parsed.data.organizationRole,
      ...(parsed.data.spaceId ? { spaceId: parsed.data.spaceId } : {}),
      ...(parsed.data.spaceRole ? { spaceRole: parsed.data.spaceRole } : {})
    });
    const acceptUrl = new URL(
      `/invite/accept?token=${encodeURIComponent(result.token)}`,
      request.url
    );
    return Response.json(
      {
        invitation: {
          id: result.invitation.id,
          email: result.invitation.email,
          organizationRole: result.invitation.organizationRole,
          spaceId: result.invitation.spaceId,
          spaceRole: result.invitation.spaceRole,
          expiresAt: result.invitation.expiresAt
        },
        acceptUrl: acceptUrl.toString()
      },
      { status: 201 }
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "INVITATION_SPACE_NOT_FOUND") return apiError(404, code, "知识空间不存在");
    if (code === "INVITATION_SPACE_REQUIRED" || code === "INVITATION_SPACE_OWNER_FORBIDDEN")
      return apiError(400, code, "空间邀请角色不正确");
    return apiError(500, "INVITATION_CREATE_FAILED", "邀请创建失败", "刷新后重试");
  }
}
