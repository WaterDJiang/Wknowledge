import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { compiledDocumentSchema } from "@wknowledge/contracts";
import { requireSpaceRole } from "@wknowledge/auth";
import { getDatabase, schema } from "@wknowledge/database";
import { parseLocatorRef } from "@wknowledge/wiki";
import { apiError, currentUser, dataRoot } from "../../../../../lib/api";
import { parsePdfPageManifest } from "../../../../../lib/pdf-region-preview";

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
    let page;
    try {
      const document = compiledDocumentSchema.parse(
        JSON.parse(await readFile(path.join(compiled, "nodes.json"), "utf8"))
      );
      const exactRegion = document.nodes.some(
        (node) =>
          node.locator.type === "pdf" &&
          node.locator.page === locator.page &&
          node.locator.bbox?.every((value, index) => value === locator.bbox![index])
      );
      if (!exactRegion) return apiError(404, "PDF_REGION_NOT_FOUND", "该 PDF 文字区域暂时不可读取");
      page = parsePdfPageManifest(
        JSON.parse(await readFile(path.join(compiled, "pdf-pages", "manifest.json"), "utf8"))
      ).pages.find((candidate) => candidate.page === locator.page);
    } catch {
      return apiError(404, "PDF_REGION_PREVIEW_UNAVAILABLE", "PDF 区域预览暂时不可读取");
    }
    if (!page) return apiError(404, "PDF_PAGE_NOT_FOUND", "PDF 页面不存在");
    let bytes;
    try {
      bytes = await readFile(path.join(compiled, page.path));
    } catch {
      return apiError(404, "PDF_PAGE_NOT_FOUND", "PDF 页面不存在");
    }
    if (!bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024)
      return apiError(404, "PDF_PAGE_NOT_FOUND", "PDF 页面不存在");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "cache-control": "private, no-store",
        "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        "content-type": "image/png",
        "x-content-type-options": "nosniff"
      }
    });
  } catch {
    return apiError(503, "PDF_REGION_PREVIEW_UNAVAILABLE", "PDF 区域预览暂时不可读取，请稍后重试");
  }
}
