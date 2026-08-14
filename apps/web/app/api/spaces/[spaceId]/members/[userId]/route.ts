import { eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { updateSpaceMemberInputSchema } from "@wknowledge/contracts";
import { removeSpaceMember, setSpaceMemberRole } from "@wknowledge/core";
import { getDatabase, schema } from "@wknowledge/database";
import { apiError, currentUser } from "../../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../../lib/request-security";

export const runtime = "nodejs";

async function managedSpace(userId: string, spaceId: string) {
  if (!(await requireSpaceRole(userId, spaceId, "admin"))) return null;
  const [space] = await getDatabase()
    .select({ organizationId: schema.knowledgeSpaces.organizationId })
    .from(schema.knowledgeSpaces)
    .where(eq(schema.knowledgeSpaces.id, spaceId))
    .limit(1);
  return space ?? null;
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ spaceId: string; userId: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId, userId } = await context.params;
  const space = await managedSpace(user.id, spaceId);
  if (!space) return apiError(403, "SPACE_ADMIN_REQUIRED", "只有空间管理员可以管理成员");
  const securityError = await enforceAuthenticatedMutation(request, user.id, "space.member.update");
  if (securityError) return securityError;
  const parsed = updateSpaceMemberInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "空间成员角色不正确", undefined, parsed.error.flatten());
  try {
    await setSpaceMemberRole({
      organizationId: space.organizationId,
      spaceId,
      userId,
      role: parsed.data.role,
      actorUserId: user.id
    });
    return Response.json({ ok: true });
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "SPACE_MEMBER_ORGANIZATION_REQUIRED")
      return apiError(409, code, "该用户尚未加入组织，请先使用邀请链接加入");
    if (code === "SPACE_OWNER_MUTATION_FORBIDDEN") return apiError(409, code, "不能修改空间所有者");
    return apiError(500, "SPACE_MEMBER_SAVE_FAILED", "空间成员保存失败", "刷新后重试");
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ spaceId: string; userId: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId, userId } = await context.params;
  const space = await managedSpace(user.id, spaceId);
  if (!space) return apiError(403, "SPACE_ADMIN_REQUIRED", "只有空间管理员可以管理成员");
  const securityError = await enforceAuthenticatedMutation(request, user.id, "space.member.remove");
  if (securityError) return securityError;
  try {
    await removeSpaceMember({
      organizationId: space.organizationId,
      spaceId,
      userId,
      actorUserId: user.id
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "SPACE_MEMBER_NOT_FOUND") return apiError(404, code, "空间成员不存在");
    if (code === "SPACE_OWNER_MUTATION_FORBIDDEN") return apiError(409, code, "不能移除空间所有者");
    return apiError(500, "SPACE_MEMBER_REMOVE_FAILED", "移除空间成员失败", "刷新后重试");
  }
}
