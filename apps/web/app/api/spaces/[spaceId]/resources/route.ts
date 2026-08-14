import { desc, eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { LocalBlobStore } from "@wknowledge/blob-store";
import {
  DIRECT_UPLOAD_MAX_BYTES,
  hasAvailableAsrProvider,
  PgBossJobQueue,
  uploadResource
} from "@wknowledge/core";
import { wikiCompileProfileSchema } from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";
import { apiError, blobRoot, currentUser } from "../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";
import { presentProcessingJob } from "../../../../../lib/processing-job";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ spaceId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId } = await context.params;
  if (!(await requireSpaceRole(user.id, spaceId, "viewer")))
    return apiError(403, "SPACE_ACCESS_DENIED", "无权访问该知识空间");
  const db = getDatabase();
  const resources = await db
    .select()
    .from(schema.resources)
    .where(eq(schema.resources.spaceId, spaceId))
    .orderBy(desc(schema.resources.updatedAt));
  const jobRows = await db
    .select({ job: schema.processingJobs, resourceId: schema.resourceVersions.resourceId })
    .from(schema.processingJobs)
    .innerJoin(
      schema.resourceVersions,
      eq(schema.processingJobs.resourceVersionId, schema.resourceVersions.id)
    )
    .where(eq(schema.processingJobs.spaceId, spaceId))
    .orderBy(desc(schema.processingJobs.createdAt));
  const versionRows = await db
    .select({
      resourceId: schema.resourceVersions.resourceId,
      compileProfile: schema.resourceVersions.compileProfile,
      version: schema.resourceVersions.version
    })
    .from(schema.resourceVersions)
    .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
    .where(eq(schema.resources.spaceId, spaceId))
    .orderBy(desc(schema.resourceVersions.createdAt));
  const latestJobByResource = new Map<string, ReturnType<typeof presentProcessingJob>>();
  for (const row of jobRows) {
    if (!latestJobByResource.has(row.resourceId))
      latestJobByResource.set(row.resourceId, presentProcessingJob(row.job));
  }
  const latestVersionByResource = new Map<string, (typeof versionRows)[number]>();
  for (const row of versionRows) {
    if (!latestVersionByResource.has(row.resourceId))
      latestVersionByResource.set(row.resourceId, row);
  }
  return Response.json({
    resources: resources.map((resource) => ({
      ...resource,
      compileProfile: latestVersionByResource.get(resource.id)?.compileProfile ?? "reference",
      currentVersion: latestVersionByResource.get(resource.id)?.version ?? 0,
      versionCount: versionRows.filter((version) => version.resourceId === resource.id).length,
      latestJob: latestJobByResource.get(resource.id) ?? null
    }))
  });
}

export async function POST(request: Request, context: { params: Promise<{ spaceId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId } = await context.params;
  if (!(await requireSpaceRole(user.id, spaceId, "editor")))
    return apiError(403, "SPACE_ACCESS_DENIED", "需要编辑权限");
  const securityError = await enforceAuthenticatedMutation(request, user.id, "resource.upload", {
    limit: 20,
    windowSeconds: 60
  });
  if (securityError) return securityError;
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return apiError(400, "UPLOAD_FILE_REQUIRED", "请选择文件");
  if (file.size > DIRECT_UPLOAD_MAX_BYTES)
    return apiError(
      400,
      "UPLOAD_CHUNK_REQUIRED",
      "大于 8 MiB 的资料需要使用分片上传",
      "请从资料处理台重新提交，浏览器会自动显示上传进度"
    );
  const compileProfile = wikiCompileProfileSchema.safeParse(
    form.get("compileProfile") ?? "knowledge"
  );
  if (!compileProfile.success)
    return apiError(400, "UPLOAD_PROFILE_INVALID", "请选择有效的知识整理模式");
  const queue = new PgBossJobQueue(process.env.DATABASE_URL ?? "");
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
    const isSupportedAudio = /\.(wav|mp3|m4a)$/i.test(file.name);
    let allowAudioAsr = false;
    if (isSupportedAudio) {
      allowAudioAsr = await hasAvailableAsrProvider(space.organizationId, space.dataPolicy);
      if (!allowAudioAsr)
        return apiError(
          409,
          "ASR_PROVIDER_REQUIRED",
          "当前知识空间没有可用的语音转文字服务",
          "请在系统设置启用并测试与空间数据策略相容的语音转文字 Provider"
        );
    }
    const result = await uploadResource(
      {
        spaceId,
        userId: user.id,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
        compileProfile: compileProfile.data,
        allowAudioAsr
      },
      new LocalBlobStore(blobRoot()),
      queue
    );
    return Response.json(result, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "UPLOAD_MIME_UNSUPPORTED")
      return apiError(
        400,
        message,
        "当前版本暂不支持此文件类型",
        "请上传 TXT、Markdown、CSV、PDF、DOCX、PPTX、XLSX、PNG、JPG、WEBP、WAV、MP3、M4A 或 MP4；音频需要已启用且健康的语音转文字 Provider"
      );
    if (message === "UPLOAD_SIZE_INVALID")
      return apiError(400, message, "文件为空或超过上传大小限制");
    if (message === "UPLOAD_NAME_INVALID")
      return apiError(
        400,
        message,
        "文件名不安全或不符合长度限制",
        "请移除路径符号或控制字符后重试"
      );
    if (message === "UPLOAD_MIME_MISMATCH")
      return apiError(
        400,
        message,
        "文件扩展名、类型或内容签名不一致",
        "确认文件没有被错误改名或损坏后重试"
      );
    if (message === "UPLOAD_ARCHIVE_UNSAFE")
      return apiError(
        400,
        message,
        "Office 文件包含不安全或不完整的压缩包结构",
        "请重新导出无宏的 DOCX、PPTX 或 XLSX 文件后重试"
      );
    if (message === "BLOB_STORAGE_FULL")
      return apiError(
        507,
        message,
        "存储空间不足，暂时无法保存文件",
        "请联系管理员释放空间后重新提交"
      );
    if (message === "STORAGE_QUOTA_EXCEEDED")
      return apiError(
        507,
        message,
        "组织存储额度不足，暂时无法保存文件",
        "请联系管理员清理资料或调整额度后重试"
      );
    return apiError(500, "UPLOAD_FAILED", "上传服务处理失败", "检查 Worker 和队列状态后重试");
  } finally {
    await queue.stop();
  }
}
