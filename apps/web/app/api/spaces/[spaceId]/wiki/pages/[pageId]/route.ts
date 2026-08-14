import path from "node:path";
import { requireSpaceRole } from "@wknowledge/auth";
import { getWikiPage } from "@wknowledge/wiki";
import { apiError, currentUser, dataRoot } from "../../../../../../../lib/api";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ spaceId: string; pageId: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId, pageId } = await context.params;
  if (!(await requireSpaceRole(user.id, spaceId, "viewer")))
    return apiError(403, "SPACE_ACCESS_DENIED", "无权查看该知识空间");

  try {
    const page = await getWikiPage(path.join(dataRoot(), spaceId), pageId);
    if (!page) return apiError(404, "WIKI_PAGE_NOT_FOUND", "知识页面不存在");
    return Response.json({ page });
  } catch (error) {
    return apiError(
      500,
      "WIKI_PAGE_READ_FAILED",
      "知识页面读取失败",
      "检查 Wiki 发布状态后重试",
      error instanceof Error ? error.message : String(error)
    );
  }
}
