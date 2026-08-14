import { eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { PgBossJobQueue, retryProcessingJob } from "@wknowledge/core";
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
    return apiError(403, "SPACE_ACCESS_DENIED", "需要编辑权限才能重新处理");
  const securityError = await enforceAuthenticatedMutation(request, user.id, "job.retry");
  if (securityError) return securityError;
  const queue = new PgBossJobQueue(process.env.DATABASE_URL ?? "");
  try {
    const result = await retryProcessingJob(
      { jobId: original.id, spaceId: original.spaceId },
      queue
    );
    return Response.json({ job: presentProcessingJob(result.job) }, { status: 202 });
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "JOB_NOT_RETRYABLE") return apiError(409, code, "只有失败任务可以重新处理");
    if (code === "JOB_RETRY_ALREADY_ACTIVE")
      return apiError(409, code, "该资料已有处理任务正在运行");
    if (code === "QUEUE_PUBLISH_FAILED")
      return apiError(503, code, "处理队列暂时不可用", "稍后再次重试");
    return apiError(500, "JOB_RETRY_FAILED", "重新处理失败", "稍后再次重试");
  } finally {
    await queue.stop();
  }
}
