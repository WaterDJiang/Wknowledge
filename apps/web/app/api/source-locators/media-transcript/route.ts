import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { compiledDocumentSchema } from "@wknowledge/contracts";
import { requireSpaceRole } from "@wknowledge/auth";
import { getDatabase, schema } from "@wknowledge/database";
import { parseLocatorRef } from "@wknowledge/wiki";
import { mediaTranscriptItems } from "../../../workspace/media-transcript";
import { apiError, currentUser, dataRoot } from "../../../../lib/api";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const ref = new URL(request.url).searchParams.get("ref");
  if (!ref) return apiError(400, "SOURCE_REF_REQUIRED", "缺少来源引用");
  let locator;
  try {
    locator = parseLocatorRef(ref);
  } catch {
    return apiError(400, "SOURCE_REF_INVALID", "来源引用格式无效");
  }
  if (locator.type !== "audio" && locator.type !== "video")
    return apiError(400, "MEDIA_LOCATOR_REQUIRED", "该来源不是音频或视频时间定位");
  try {
    const [row] = await getDatabase()
      .select({ resource: schema.resources })
      .from(schema.resourceVersions)
      .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
      .where(eq(schema.resourceVersions.id, locator.resourceVersionId))
      .limit(1);
    if (!row) return apiError(404, "SOURCE_NOT_FOUND", "来源版本不存在");
    if (!(await requireSpaceRole(user.id, row.resource.spaceId, "viewer")))
      return apiError(403, "SPACE_ACCESS_DENIED", "无权查看该来源");
    let document;
    try {
      document = compiledDocumentSchema.parse(
        JSON.parse(
          await readFile(
            path.join(
              dataRoot(),
              row.resource.spaceId,
              "compiled",
              locator.resourceVersionId,
              "nodes.json"
            ),
            "utf8"
          )
        )
      );
    } catch {
      return Response.json({ items: [] });
    }
    return Response.json({ items: mediaTranscriptItems(document.nodes, locator) });
  } catch {
    return apiError(503, "MEDIA_TRANSCRIPT_UNAVAILABLE", "媒体文字暂时不可读取，请稍后重试");
  }
}
