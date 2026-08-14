import path from "node:path";
import { requireSpaceRole } from "@wknowledge/auth";
import { getWikiPage, listWikiPageChangeProposals, listWikiPageRevisions } from "@wknowledge/wiki";
import { apiError, currentUser, dataRoot } from "../../../../../../../../lib/api";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ spaceId: string; pageId: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId, pageId } = await context.params;
  if (!(await requireSpaceRole(user.id, spaceId, "editor")))
    return apiError(403, "SPACE_EDIT_DENIED", "无权查看待审核变更");

  try {
    const spaceRoot = path.join(dataRoot(), spaceId);
    if (!(await getWikiPage(spaceRoot, pageId)))
      return apiError(404, "WIKI_PAGE_NOT_FOUND", "知识页面不存在");
    const [proposals, revisions] = await Promise.all([
      listWikiPageChangeProposals(spaceRoot, pageId),
      listWikiPageRevisions(spaceRoot, pageId)
    ]);
    return Response.json({ proposals, revisions });
  } catch (error) {
    return apiError(
      500,
      "WIKI_PROPOSAL_LIST_FAILED",
      "待审核变更读取失败",
      "刷新页面后重试",
      error instanceof Error ? error.message : String(error)
    );
  }
}
