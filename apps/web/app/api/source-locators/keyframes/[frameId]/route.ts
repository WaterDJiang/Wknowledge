import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { compiledDocumentSchema } from "@wknowledge/contracts";
import { requireSpaceRole } from "@wknowledge/auth";
import { getDatabase, schema } from "@wknowledge/database";
import { parseLocatorRef } from "@wknowledge/wiki";
import { apiError, currentUser, dataRoot } from "../../../../../lib/api";

export const runtime = "nodejs";

const FRAME_ID = /^keyframe-\d{3}$/;
const FRAME_PATH = /^keyframes\/frame-\d{3}\.jpg$/;

export async function GET(request: Request, context: { params: Promise<{ frameId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { frameId } = await context.params;
  if (!FRAME_ID.test(frameId)) return apiError(404, "VIDEO_KEYFRAME_NOT_FOUND", "关键帧不存在");
  const ref = new URL(request.url).searchParams.get("ref");
  if (!ref) return apiError(400, "SOURCE_REF_REQUIRED", "缺少来源引用");
  let locator;
  try {
    locator = parseLocatorRef(ref);
  } catch {
    return apiError(400, "SOURCE_REF_INVALID", "来源引用格式无效");
  }
  if (locator.type !== "video")
    return apiError(400, "VIDEO_LOCATOR_REQUIRED", "该来源不是视频时间定位");
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
      return apiError(404, "VIDEO_KEYFRAME_NOT_FOUND", "关键帧不存在");
    }
    const frame = document.nodes.find(
      (node) =>
        node.id === frameId &&
        node.kind === "image" &&
        node.locator.type === "video" &&
        node.locator.resourceVersionId === locator.resourceVersionId &&
        node.locator.startMs < locator.endMs &&
        node.locator.endMs > locator.startMs &&
        node.metadata.source === "video_keyframe" &&
        typeof node.metadata.assetPath === "string" &&
        FRAME_PATH.test(node.metadata.assetPath)
    );
    if (!frame || typeof frame.metadata.assetPath !== "string")
      return apiError(404, "VIDEO_KEYFRAME_NOT_FOUND", "关键帧不存在");
    let bytes;
    try {
      bytes = await readFile(
        path.join(
          dataRoot(),
          row.resource.spaceId,
          "compiled",
          locator.resourceVersionId,
          frame.metadata.assetPath
        )
      );
    } catch {
      return apiError(404, "VIDEO_KEYFRAME_NOT_FOUND", "关键帧不存在");
    }
    if (!bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024)
      return apiError(404, "VIDEO_KEYFRAME_NOT_FOUND", "关键帧不存在");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "cache-control": "private, no-store",
        "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        "content-type": "image/jpeg",
        "x-content-type-options": "nosniff"
      }
    });
  } catch {
    return apiError(503, "VIDEO_KEYFRAME_UNAVAILABLE", "视频关键帧暂时不可读取，请稍后重试");
  }
}
