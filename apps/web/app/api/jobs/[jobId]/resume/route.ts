import { eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { PgBossJobQueue, resumeProcessingJob } from "@wknowledge/core";
import { getDatabase, schema } from "@wknowledge/database";
import { apiError, currentUser } from "../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";
import { presentProcessingJob } from "../../../../../lib/processing-job";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { jobId } = await context.params;
  const [original] = await getDatabase()
    .select({ id: schema.processingJobs.id, spaceId: schema.processingJobs.spaceId })
    .from(schema.processingJobs)
    .where(eq(schema.processingJobs.id, jobId))
    .limit(1);
  if (!original) return apiError(404, "JOB_NOT_FOUND", "任务不存在");
  if (!(await requireSpaceRole(user.id, original.spaceId, "editor")))
    return apiError(403, "SPACE_ACCESS_DENIED", "需要编辑权限才能恢复处理");
  const securityError = await enforceAuthenticatedMutation(request, user.id, "job.resume");
  if (securityError) return securityError;

  const queue = new PgBossJobQueue(process.env.DATABASE_URL ?? "");
  try {
    const result = await resumeProcessingJob(
      { jobId: original.id, spaceId: original.spaceId },
      queue
    );
    return Response.json({ job: presentProcessingJob(result.job) }, { status: 202 });
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "JOB_NOT_RESUMABLE")
      return apiError(409, code, "当前任务不能恢复", "仅可恢复已取消的任务");
    if (code === "JOB_RESUME_ALREADY_ACTIVE")
      return apiError(409, code, "该资料已有处理任务正在运行");
    if (code === "QUEUE_PUBLISH_FAILED")
      return apiError(503, code, "处理队列暂时不可用", "稍后再次重试");
    return apiError(500, "JOB_RESUME_FAILED", "恢复处理失败", "刷新资料列表后重试");
  } finally {
    await queue.stop();
  }
}
