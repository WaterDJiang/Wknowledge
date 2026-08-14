import path from "node:path";
import { requireSpaceRole } from "@wknowledge/auth";
import { wikiPageListQuerySchema } from "@wknowledge/contracts";
import { listWikiPages } from "@wknowledge/wiki";
import { apiError, currentUser, dataRoot } from "../../../../../../lib/api";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ spaceId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId } = await context.params;
  if (!(await requireSpaceRole(user.id, spaceId, "viewer")))
    return apiError(403, "SPACE_ACCESS_DENIED", "无权查看该知识空间");

  const searchParams = new URL(request.url).searchParams;
  const parsed = wikiPageListQuerySchema.safeParse({
    ...(searchParams.has("search") ? { search: searchParams.get("search") } : {}),
    ...(searchParams.has("status") ? { status: searchParams.get("status") } : {}),
    ...(searchParams.has("type") ? { types: searchParams.getAll("type") } : {})
  });
  if (!parsed.success)
    return apiError(
      400,
      "INPUT_INVALID",
      "知识页面筛选条件不正确",
      undefined,
      parsed.error.flatten()
    );

  try {
    const pages = await listWikiPages(path.join(dataRoot(), spaceId), parsed.data);
    return Response.json({ pages, total: pages.length });
  } catch (error) {
    return apiError(
      500,
      "WIKI_LIST_FAILED",
      "知识页面读取失败",
      "检查 Wiki 发布状态后重试",
      error instanceof Error ? error.message : String(error)
    );
  }
}
