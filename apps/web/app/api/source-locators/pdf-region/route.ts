import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { compiledDocumentSchema } from "@wknowledge/contracts";
import { requireSpaceRole } from "@wknowledge/auth";
import { getDatabase, schema } from "@wknowledge/database";
import { parseLocatorRef } from "@wknowledge/wiki";
import { apiError, currentUser, dataRoot } from "../../../../lib/api";
import { parsePdfPageManifest, selectPdfRegionPreview } from "../../../../lib/pdf-region-preview";

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
  if (locator.type !== "pdf" || !locator.bbox)
    return apiError(400, "PDF_REGION_LOCATOR_REQUIRED", "该来源不是 PDF 文字区域定位");
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
    const compiled = path.join(
      dataRoot(),
      row.resource.spaceId,
      "compiled",
      locator.resourceVersionId
    );
    let document;
    let pageManifest;
    try {
      document = compiledDocumentSchema.parse(
        JSON.parse(await readFile(path.join(compiled, "nodes.json"), "utf8"))
      );
      pageManifest = parsePdfPageManifest(
        JSON.parse(await readFile(path.join(compiled, "pdf-pages", "manifest.json"), "utf8"))
      );
    } catch {
      return apiError(404, "PDF_REGION_PREVIEW_UNAVAILABLE", "PDF 区域预览暂时不可读取");
    }
    const preview = selectPdfRegionPreview(document, pageManifest, locator);
    if (!preview) return apiError(404, "PDF_REGION_NOT_FOUND", "该 PDF 文字区域暂时不可读取");
    return Response.json({ preview });
  } catch {
    return apiError(503, "PDF_REGION_PREVIEW_UNAVAILABLE", "PDF 区域预览暂时不可读取，请稍后重试");
  }
}
