import path from "node:path";
import { eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { wikiConflictDecisionInputSchema } from "@wknowledge/contracts";
import { getDatabase, schema, withWikiPublicationLease } from "@wknowledge/database";
import { decideWikiConflict, getWikiConflict } from "@wknowledge/wiki";
import { apiError, currentUser, dataRoot } from "../../../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../../../lib/request-security";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ spaceId: string; conflictId: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId, conflictId } = await context.params;
  if (!(await requireSpaceRole(user.id, spaceId, "viewer")))
    return apiError(403, "SPACE_ACCESS_DENIED", "无权查看知识冲突");
  try {
    const conflict = await getWikiConflict(path.join(dataRoot(), spaceId), conflictId);
    if (!conflict) return apiError(404, "WIKI_CONFLICT_NOT_FOUND", "知识冲突不存在");
    return Response.json({ conflict });
  } catch (error) {
    return apiError(
      500,
      "WIKI_CONFLICT_READ_FAILED",
      "冲突详情读取失败",
      "刷新页面后重试",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ spaceId: string; conflictId: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId, conflictId } = await context.params;
  if (!(await requireSpaceRole(user.id, spaceId, "editor")))
    return apiError(403, "SPACE_EDIT_DENIED", "无权裁决知识冲突");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "wiki.conflict.decide"
  );
  if (securityError) return securityError;
  const parsed = wikiConflictDecisionInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "冲突裁决操作不正确", undefined, parsed.error.flatten());

  try {
    const db = getDatabase();
    const [space] = await db
      .select({ organizationId: schema.knowledgeSpaces.organizationId })
      .from(schema.knowledgeSpaces)
      .where(eq(schema.knowledgeSpaces.id, spaceId))
      .limit(1);
    if (!space) return apiError(404, "SPACE_NOT_FOUND", "知识空间不存在");
    const conflict = await withWikiPublicationLease(spaceId, "wiki.conflict.decide", () =>
      decideWikiConflict(path.join(dataRoot(), spaceId), {
        conflictId,
        ...parsed.data,
        actorUserId: user.id
      })
    );
    await db.insert(schema.auditEvents).values({
      organizationId: space.organizationId,
      actorUserId: user.id,
      action: "wiki.conflict.resolved",
      targetType: "wiki_conflict",
      targetId: conflict.id,
      metadata: { spaceId, resolution: conflict.resolution }
    });
    return Response.json({ conflict });
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "WIKI_CONFLICT_NOT_FOUND")
      return apiError(404, code, "知识冲突不存在", "刷新页面后重试");
    if (code === "WIKI_CONFLICT_STATE_INVALID")
      return apiError(409, code, "冲突状态已经变化", "刷新页面后重新裁决");
    if (code === "WIKI_PUBLICATION_LOCKED" || code === "WIKI_PUBLICATION_LEASE_LOST")
      return apiError(409, code, "知识库正在发布其他变更", "稍后刷新页面后重试");
    return apiError(500, "WIKI_CONFLICT_DECISION_FAILED", "冲突裁决保存失败", "刷新后重试", code);
  }
}
