import { requireSpaceRole } from "@wknowledge/auth";
import { completeChunkedUploadInputSchema } from "@wknowledge/contracts";
import { getChunkedUploadSession, requestChunkedUploadFinalization } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../lib/api";
import { chunkedUploadError } from "../../../../../lib/chunked-upload-api";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ uploadId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const uploadId = (await context.params).uploadId;
  try {
    const session = await getChunkedUploadSession(uploadId, user.id);
    if (!(await requireSpaceRole(user.id, session.upload.spaceId, "editor")))
      return apiError(403, "SPACE_ACCESS_DENIED", "需要编辑权限");
    const securityError = await enforceAuthenticatedMutation(
      request,
      user.id,
      "resource.upload.complete",
      {
        limit: 20,
        windowSeconds: 60
      }
    );
    if (securityError) return securityError;
    const parsed = completeChunkedUploadInputSchema.safeParse(
      await request.json().catch(() => null)
    );
    if (!parsed.success) return apiError(400, "UPLOAD_SESSION_INVALID", "上传完成信息格式不正确");
    const result = await requestChunkedUploadFinalization({
      uploadId,
      userId: user.id,
      sha256: parsed.data.sha256
    });
    return Response.json(result, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    return chunkedUploadError(error);
  }
}
