import { requireSpaceRole } from "@wknowledge/auth";
import { getChunkedUploadSession } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../lib/api";
import { chunkedUploadError } from "../../../../lib/chunked-upload-api";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ uploadId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  try {
    const session = await getChunkedUploadSession((await context.params).uploadId, user.id);
    if (!(await requireSpaceRole(user.id, session.upload.spaceId, "editor")))
      return apiError(403, "SPACE_ACCESS_DENIED", "需要编辑权限");
    return Response.json(session, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return chunkedUploadError(error);
  }
}
