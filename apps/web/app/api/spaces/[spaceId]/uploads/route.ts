import { requireSpaceRole } from "@wknowledge/auth";
import { createChunkedUploadInputSchema } from "@wknowledge/contracts";
import { createChunkedUploadSession, hasAvailableAsrProvider } from "@wknowledge/core";
import { LocalBlobStore } from "@wknowledge/blob-store";
import { eq } from "drizzle-orm";
import { getDatabase, schema } from "@wknowledge/database";
import { apiError, blobRoot, currentUser } from "../../../../../lib/api";
import { chunkedUploadError } from "../../../../../lib/chunked-upload-api";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ spaceId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId } = await context.params;
  if (!(await requireSpaceRole(user.id, spaceId, "editor")))
    return apiError(403, "SPACE_ACCESS_DENIED", "需要编辑权限");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "resource.upload.create",
    {
      limit: 20,
      windowSeconds: 60
    }
  );
  if (securityError) return securityError;
  const parsed = createChunkedUploadInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "UPLOAD_SESSION_INVALID", "上传会话信息不完整或格式不正确");
  try {
    const [space] = await getDatabase()
      .select({
        organizationId: schema.knowledgeSpaces.organizationId,
        dataPolicy: schema.knowledgeSpaces.dataPolicy
      })
      .from(schema.knowledgeSpaces)
      .where(eq(schema.knowledgeSpaces.id, spaceId))
      .limit(1);
    if (!space) return apiError(404, "SPACE_NOT_FOUND", "知识空间不存在");
    const isSupportedAudio = /\.(wav|mp3|m4a)$/i.test(parsed.data.name);
    const allowAudioAsr = isSupportedAudio
      ? await hasAvailableAsrProvider(space.organizationId, space.dataPolicy)
      : false;
    if (isSupportedAudio && !allowAudioAsr)
      return apiError(
        409,
        "ASR_PROVIDER_REQUIRED",
        "当前知识空间没有可用的语音转文字服务",
        "请在系统设置启用并测试与空间数据策略相容的语音转文字 Provider"
      );
    const blobStore = new LocalBlobStore(blobRoot());
    const session = await createChunkedUploadSession(
      { ...parsed.data, spaceId, userId: user.id, allowAudioAsr },
      { assertWriteCapacity: blobStore.assertWriteCapacity.bind(blobStore) }
    );
    return Response.json(session, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return chunkedUploadError(error);
  }
}
