import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { compiledDocumentSchema } from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";
import { parseLocatorRef } from "@wknowledge/wiki";
import { apiError, currentUser, dataRoot } from "../../../../lib/api";
import { selectImagePreview } from "../../../../lib/image-preview";

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
  if (locator.type !== "image" || !locator.bbox)
    return apiError(400, "IMAGE_REGION_LOCATOR_REQUIRED", "该来源不是图片区域定位");
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
      return apiError(404, "IMAGE_PREVIEW_UNAVAILABLE", "图片派生内容暂时不可读取");
    }
    const preview = selectImagePreview(document, locator);
    if (!preview) return apiError(404, "IMAGE_REGION_NOT_FOUND", "该图片区域暂时不可读取");
    return Response.json({ preview });
  } catch {
    return apiError(503, "IMAGE_PREVIEW_UNAVAILABLE", "图片预览服务暂时不可用，请稍后重试");
  }
}
