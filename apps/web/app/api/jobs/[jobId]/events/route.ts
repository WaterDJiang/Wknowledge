import { eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { getDatabase, schema } from "@wknowledge/database";
import { apiError, currentUser } from "../../../../../lib/api";
import { presentProcessingJob } from "../../../../../lib/processing-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { jobId } = await context.params;
  const db = getDatabase();
  const [initial] = await db
    .select()
    .from(schema.processingJobs)
    .where(eq(schema.processingJobs.id, jobId))
    .limit(1);
  if (!initial) return apiError(404, "JOB_NOT_FOUND", "任务不存在");
  if (!(await requireSpaceRole(user.id, initial.spaceId, "viewer"))) {
    return apiError(403, "SPACE_ACCESS_DENIED", "无权查看该任务");
  }

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = async () => {
        const [job] = await db
          .select()
          .from(schema.processingJobs)
          .where(eq(schema.processingJobs.id, jobId))
          .limit(1);
        if (!job) {
          controller.enqueue(encoder.encode('event: error\ndata: {"code":"JOB_NOT_FOUND"}\n\n'));
          controller.close();
          if (timer) clearInterval(timer);
          return;
        }
        controller.enqueue(
          encoder.encode(`event: progress\ndata: ${JSON.stringify(presentProcessingJob(job))}\n\n`)
        );
        if (["completed", "failed", "cancelled"].includes(job.status)) {
          controller.close();
          if (timer) clearInterval(timer);
        }
      };
      void emit();
      timer = setInterval(() => void emit(), 1_000);
      request.signal.addEventListener("abort", () => {
        if (timer) clearInterval(timer);
      });
    },
    cancel() {
      if (timer) clearInterval(timer);
    }
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
}
