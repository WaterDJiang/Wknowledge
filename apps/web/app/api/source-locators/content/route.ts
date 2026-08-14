import { eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { LocalBlobStore } from "@wknowledge/blob-store";
import { getDatabase, schema } from "@wknowledge/database";
import { parseLocatorRef } from "@wknowledge/wiki";
import { apiError, blobRoot, currentUser } from "../../../../lib/api";
import { sourceContentDisposition } from "../../../../lib/source-content-policy";

export const runtime = "nodejs";

function rangeFor(header: string | null, byteSize: number): { start: number; end: number } | null {
  if (!header) return { start: 0, end: byteSize - 1 };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const [, startText, endText] = match;
  if (!startText && !endText) return null;
  if (!startText) {
    const suffixSize = Number(endText);
    if (!Number.isSafeInteger(suffixSize) || suffixSize <= 0) return null;
    return { start: Math.max(0, byteSize - suffixSize), end: byteSize - 1 };
  }
  const start = Number(startText);
  const end = endText ? Number(endText) : byteSize - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= byteSize ||
    end < start
  )
    return null;
  return { start, end: Math.min(end, byteSize - 1) };
}

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
  try {
    const [row] = await getDatabase()
      .select({ version: schema.resourceVersions, resource: schema.resources })
      .from(schema.resourceVersions)
      .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
      .where(eq(schema.resourceVersions.id, locator.resourceVersionId))
      .limit(1);
    if (!row) return apiError(404, "SOURCE_NOT_FOUND", "来源版本不存在");
    if (!(await requireSpaceRole(user.id, row.resource.spaceId, "viewer")))
      return apiError(403, "SPACE_ACCESS_DENIED", "无权查看该来源");
    const range = rangeFor(request.headers.get("range"), row.version.byteSize);
    if (!range)
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${row.version.byteSize}` }
      });
    let content: Buffer;
    try {
      content = await new LocalBlobStore(blobRoot()).readRange(
        row.version.blobUri,
        range.start,
        range.end
      );
    } catch {
      return apiError(404, "SOURCE_CONTENT_UNAVAILABLE", "原始资料暂时不可读取");
    }
    const body = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    const isPartial = range.start !== 0 || range.end !== row.version.byteSize - 1;
    return new Response(body as unknown as BodyInit, {
      status: isPartial ? 206 : 200,
      headers: {
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "content-disposition": sourceContentDisposition(
          row.version.mimeType,
          row.version.version,
          locator.type
        ),
        "content-length": String(body.byteLength),
        "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        "content-type": row.version.mimeType,
        "x-content-type-options": "nosniff",
        ...(isPartial
          ? { "content-range": `bytes ${range.start}-${range.end}/${row.version.byteSize}` }
          : {})
      }
    });
  } catch {
    return apiError(503, "SOURCE_LOOKUP_UNAVAILABLE", "来源服务暂时不可用，请稍后重试");
  }
}
