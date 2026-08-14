import { requireSpaceRole } from "@wknowledge/auth";
import {
  CHUNKED_UPLOAD_PART_BYTES,
  getChunkedUploadSession,
  putChunkedUploadPart
} from "@wknowledge/core";
import { LocalBlobStore } from "@wknowledge/blob-store";
import { apiError, blobRoot, currentUser } from "../../../../../../lib/api";
import {
  chunkedUploadError,
  readChunkedUploadPartBytes
} from "../../../../../../lib/chunked-upload-api";
import { enforceAuthenticatedMutation } from "../../../../../../lib/request-security";

export const runtime = "nodejs";

export async function PUT(
  request: Request,
  context: { params: Promise<{ uploadId: string; partNumber: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { uploadId, partNumber: partValue } = await context.params;
  const partNumber = Number(partValue);
  if (!Number.isInteger(partNumber))
    return apiError(400, "UPLOAD_PART_RANGE_INVALID", "分片序号不正确");
  try {
    const session = await getChunkedUploadSession(uploadId, user.id);
    if (!(await requireSpaceRole(user.id, session.upload.spaceId, "editor")))
      return apiError(403, "SPACE_ACCESS_DENIED", "需要编辑权限");
    const securityError = await enforceAuthenticatedMutation(
      request,
      user.id,
      "resource.upload.part",
      {
        limit: 180,
        windowSeconds: 60
      }
    );
    if (securityError) return securityError;
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > CHUNKED_UPLOAD_PART_BYTES)
      return apiError(400, "UPLOAD_PART_SIZE_INVALID", "分片超过允许大小");
    const bytes = await readChunkedUploadPartBytes(request.body, CHUNKED_UPLOAD_PART_BYTES);
    const progress = await putChunkedUploadPart({
      uploadId,
      userId: user.id,
      partNumber,
      bytes,
      blobStore: new LocalBlobStore(blobRoot())
    });
    return Response.json(progress, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return chunkedUploadError(error);
  }
}
