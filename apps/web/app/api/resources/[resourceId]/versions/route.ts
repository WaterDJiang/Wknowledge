import { desc, eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { LocalBlobStore } from "@wknowledge/blob-store";
import { DIRECT_UPLOAD_MAX_BYTES, PgBossJobQueue, replaceResourceVersion } from "@wknowledge/core";
import { wikiCompileProfileSchema } from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";
import { apiError, blobRoot, currentUser } from "../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";
import { presentProcessingJob } from "../../../../../lib/processing-job";

export const runtime = "nodejs";

async function resourceForUser(resourceId: string, userId: string, role: "viewer" | "editor") {
  const [resource] = await getDatabase()
    .select()
    .from(schema.resources)
    .where(eq(schema.resources.id, resourceId))
    .limit(1);
  if (!resource) return { error: apiError(404, "RESOURCE_NOT_FOUND", "资料不存在") };
  if (!(await requireSpaceRole(userId, resource.spaceId, role)))
    return { error: apiError(403, "SPACE_ACCESS_DENIED", "无权访问该资料") };
  return { resource };
}

export async function GET(_request: Request, context: { params: Promise<{ resourceId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const access = await resourceForUser((await context.params).resourceId, user.id, "viewer");
  if (access.error) return access.error;
  const versions = await getDatabase()
    .select()
    .from(schema.resourceVersions)
    .where(eq(schema.resourceVersions.resourceId, access.resource.id))
    .orderBy(desc(schema.resourceVersions.version));
  const jobs = await getDatabase()
    .select()
    .from(schema.processingJobs)
    .where(eq(schema.processingJobs.spaceId, access.resource.spaceId))
    .orderBy(desc(schema.processingJobs.createdAt));
  const latestJobByVersion = new Map<string, ReturnType<typeof presentProcessingJob>>();
  for (const job of jobs) {
    if (job.resourceVersionId && !latestJobByVersion.has(job.resourceVersionId))
      latestJobByVersion.set(job.resourceVersionId, presentProcessingJob(job));
  }
  return Response.json({
    versions: versions.map(({ blobUri: _blobUri, ...version }) => ({
      ...version,
      latestJob: latestJobByVersion.get(version.id) ?? null
    }))
  });
}

export async function POST(request: Request, context: { params: Promise<{ resourceId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const access = await resourceForUser((await context.params).resourceId, user.id, "editor");
  if (access.error) return access.error;
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "resource.version.replace",
    {
      limit: 20,
      windowSeconds: 60
    }
  );
  if (securityError) return securityError;
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return apiError(400, "UPLOAD_FILE_REQUIRED", "请选择替换文件");
  if (file.size > DIRECT_UPLOAD_MAX_BYTES)
    return apiError(
      400,
      "UPLOAD_CHUNK_REQUIRED",
      "大于 8 MiB 的替换资料即将支持分片上传",
      "请先选择不超过 8 MiB 的文件"
    );
  const compileProfile = wikiCompileProfileSchema.safeParse(
    form.get("compileProfile") ?? "knowledge"
  );
  if (!compileProfile.success)
    return apiError(400, "UPLOAD_PROFILE_INVALID", "请选择有效的知识整理模式");
  const queue = new PgBossJobQueue(process.env.DATABASE_URL ?? "");
  try {
    const result = await replaceResourceVersion(
      {
        resourceId: access.resource.id,
        spaceId: access.resource.spaceId,
        userId: user.id,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer()),
        compileProfile: compileProfile.data
      },
      new LocalBlobStore(blobRoot()),
      queue
    );
    return Response.json(result, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "RESOURCE_VERSION_FAILED";
    if (code === "BLOB_STORAGE_FULL")
      return apiError(507, code, "存储空间不足，暂时无法保存文件", "请联系管理员释放空间后重试");
    if (code === "STORAGE_QUOTA_EXCEEDED")
      return apiError(
        507,
        code,
        "组织存储额度不足，暂时无法保存文件",
        "请联系管理员清理资料或调整额度后重试"
      );
    if (code === "UPLOAD_NAME_INVALID" || code === "UPLOAD_MIME_MISMATCH")
      return apiError(400, code, "文件名、类型或内容签名不符合要求");
    if (code === "UPLOAD_MIME_UNSUPPORTED")
      return apiError(400, code, "当前版本暂不支持此文件类型");
    if (code === "UPLOAD_ARCHIVE_UNSAFE")
      return apiError(400, code, "Office 文件包含不安全或不完整的压缩包结构");
    return apiError(500, "RESOURCE_VERSION_FAILED", "替换资料失败，请稍后重试");
  } finally {
    await queue.stop();
  }
}
