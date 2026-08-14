import { eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { cancelProcessingJob, PgBossJobQueue } from "@wknowledge/core";
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
    return apiError(403, "SPACE_ACCESS_DENIED", "需要编辑权限才能取消处理");
  const securityError = await enforceAuthenticatedMutation(request, user.id, "job.cancel");
  if (securityError) return securityError;

  const queue = new PgBossJobQueue(process.env.DATABASE_URL ?? "");
  try {
    const result = await cancelProcessingJob(
      { jobId: original.id, spaceId: original.spaceId },
      queue
    );
    return Response.json({ job: presentProcessingJob(result.job) }, { status: 202 });
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "JOB_NOT_CANCELLABLE")
      return apiError(409, code, "当前任务不能取消", "仅可取消排队中或正在处理的任务");
    return apiError(500, "JOB_CANCEL_FAILED", "取消处理失败", "刷新资料列表后重试");
  } finally {
    await queue.stop();
  }
}
