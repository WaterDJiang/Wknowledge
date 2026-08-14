import { requireSpaceRole } from "@wknowledge/auth";
import { listSpaceMembers } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../lib/api";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ spaceId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId } = await context.params;
  if (!(await requireSpaceRole(user.id, spaceId, "viewer")))
    return apiError(403, "SPACE_ACCESS_DENIED", "无权查看知识空间成员");
  return Response.json({ members: await listSpaceMembers(spaceId) });
}
