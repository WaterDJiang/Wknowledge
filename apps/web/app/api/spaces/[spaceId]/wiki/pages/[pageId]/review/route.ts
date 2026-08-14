import path from "node:path";
import { eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { wikiReviewInputSchema } from "@wknowledge/contracts";
import { getDatabase, schema, withWikiPublicationLease } from "@wknowledge/database";
import { reviewWikiPage } from "@wknowledge/wiki";
import { apiError, currentUser, dataRoot } from "../../../../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../../../../lib/request-security";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ spaceId: string; pageId: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId, pageId } = await context.params;
  const membership = await requireSpaceRole(user.id, spaceId, "editor");
  if (!membership) return apiError(403, "SPACE_EDIT_DENIED", "无权审核该知识空间");
  const securityError = await enforceAuthenticatedMutation(request, user.id, "wiki.page.review");
  if (securityError) return securityError;

  const parsed = wikiReviewInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "审核操作不正确", undefined, parsed.error.flatten());

  try {
    const db = getDatabase();
    const [space] = await db
      .select({ organizationId: schema.knowledgeSpaces.organizationId })
      .from(schema.knowledgeSpaces)
      .where(eq(schema.knowledgeSpaces.id, spaceId))
      .limit(1);
    if (!space) return apiError(404, "SPACE_NOT_FOUND", "知识空间不存在");
    const page = await withWikiPublicationLease(spaceId, "wiki.review", () =>
      reviewWikiPage(path.join(dataRoot(), spaceId), {
        pageId,
        action: parsed.data.action,
        reviewerId: user.id
      })
    );
    await db.insert(schema.auditEvents).values({
      organizationId: space.organizationId,
      actorUserId: user.id,
      action: parsed.data.action === "approve" ? "wiki.page.approved" : "wiki.page.reopened",
      targetType: "wiki_page",
      targetId: pageId,
      metadata: { spaceId }
    });
    return Response.json({ page });
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "WIKI_PAGE_NOT_FOUND")
      return apiError(404, code, "知识页面不存在", "刷新知识索引后重试");
    if (code === "WIKI_REVIEW_STATE_INVALID")
      return apiError(409, code, "页面状态已经变化", "刷新页面后再执行审核操作");
    if (code === "WIKI_PUBLICATION_LOCKED" || code === "WIKI_PUBLICATION_LEASE_LOST")
      return apiError(409, code, "知识库正在发布其他变更", "稍后刷新页面后重试");
    return apiError(500, "WIKI_REVIEW_FAILED", "审核操作失败", "刷新后重试", code);
  }
}
