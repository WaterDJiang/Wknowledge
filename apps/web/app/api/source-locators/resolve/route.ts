import { eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { getDatabase, schema } from "@wknowledge/database";
import { parseLocatorRef } from "@wknowledge/wiki";
import { apiError, currentUser } from "../../../../lib/api";

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
    return Response.json({
      locator,
      resource: { id: row.resource.id, name: row.resource.name },
      version: { id: row.version.id, version: row.version.version, mimeType: row.version.mimeType }
    });
  } catch {
    return apiError(503, "SOURCE_LOOKUP_UNAVAILABLE", "来源服务暂时不可用，请稍后重试");
  }
}
