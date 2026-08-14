import { eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { getDatabase, schema } from "@wknowledge/database";
import { apiError, currentUser } from "../../../../lib/api";
import { presentProcessingJob } from "../../../../lib/processing-job";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { jobId } = await context.params;
  const [job] = await getDatabase()
    .select()
    .from(schema.processingJobs)
    .where(eq(schema.processingJobs.id, jobId))
    .limit(1);
  if (!job) return apiError(404, "JOB_NOT_FOUND", "任务不存在");
  if (!(await requireSpaceRole(user.id, job.spaceId, "viewer")))
    return apiError(403, "SPACE_ACCESS_DENIED", "无权查看该任务");
  return Response.json({ job: presentProcessingJob(job) });
}
