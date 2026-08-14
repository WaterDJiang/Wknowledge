import path from "node:path";
import { eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { createWikiConflictInputSchema } from "@wknowledge/contracts";
import { getDatabase, schema, withWikiPublicationLease } from "@wknowledge/database";
import { declareWikiConflict } from "@wknowledge/wiki";
import { apiError, currentUser, dataRoot } from "../../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../../lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ spaceId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId } = await context.params;
  if (!(await requireSpaceRole(user.id, spaceId, "editor")))
    return apiError(403, "SPACE_EDIT_DENIED", "无权声明知识冲突");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "wiki.conflict.declare"
  );
  if (securityError) return securityError;
  const parsed = createWikiConflictInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "冲突页面选择不正确", undefined, parsed.error.flatten());

  try {
    const db = getDatabase();
    const [space] = await db
      .select({ organizationId: schema.knowledgeSpaces.organizationId })
      .from(schema.knowledgeSpaces)
      .where(eq(schema.knowledgeSpaces.id, spaceId))
      .limit(1);
    if (!space) return apiError(404, "SPACE_NOT_FOUND", "知识空间不存在");
    const conflict = await withWikiPublicationLease(spaceId, "wiki.conflict.declare", () =>
      declareWikiConflict(path.join(dataRoot(), spaceId), {
        ...parsed.data,
        actorUserId: user.id
      })
    );
    await db.insert(schema.auditEvents).values({
      organizationId: space.organizationId,
      actorUserId: user.id,
      action: "wiki.conflict.declared",
      targetType: "wiki_conflict",
      targetId: conflict.id,
      metadata: { spaceId, leftPageId: conflict.leftPageId, rightPageId: conflict.rightPageId }
    });
    return Response.json({ conflict }, { status: 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "WIKI_PAGE_NOT_FOUND")
      return apiError(404, code, "选择的知识页面不存在", "刷新知识库后重试");
    if (code === "WIKI_CONFLICT_ALREADY_OPEN")
      return apiError(409, code, "这两份知识已经存在待裁决冲突", "打开现有冲突后继续处理");
    if (code === "WIKI_PUBLICATION_LOCKED" || code === "WIKI_PUBLICATION_LEASE_LOST")
      return apiError(409, code, "知识库正在发布其他变更", "稍后刷新页面后重试");
    return apiError(500, "WIKI_CONFLICT_DECLARE_FAILED", "冲突声明保存失败", "刷新后重试", code);
  }
}
