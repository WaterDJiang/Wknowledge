import { getManagedOrganization } from "@wknowledge/auth";
import { apiError, currentUser } from "./api";
import { enforceAuthenticatedMutation } from "./request-security";

export async function settingsAdmin() {
  const user = await currentUser();
  if (!user) return { error: apiError(401, "AUTH_REQUIRED", "请先登录") } as const;
  const membership = await getManagedOrganization(user.id);
  if (!membership)
    return {
      error: apiError(403, "SETTINGS_ACCESS_DENIED", "只有组织管理员可以管理设置")
    } as const;
  return { user, organizationId: membership.organizationId } as const;
}

export async function settingsAdminMutation(request: Request, scope: string) {
  const admin = await settingsAdmin();
  if ("error" in admin) return admin;
  const securityError = await enforceAuthenticatedMutation(request, admin.user.id, scope);
  if (securityError) return { error: securityError } as const;
  return admin;
}
