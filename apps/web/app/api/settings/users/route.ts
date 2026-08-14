import { getManagedOrganization } from "@wknowledge/auth";
import { listOrganizationUsers } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../lib/api";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const organization = await getManagedOrganization(user.id);
  if (!organization) return apiError(403, "ORG_ADMIN_REQUIRED", "只有组织管理员可以管理用户");
  return Response.json({ users: await listOrganizationUsers(organization.organizationId) });
}
