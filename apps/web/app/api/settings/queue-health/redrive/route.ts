import { redriveDeadLetterInputSchema } from "@wknowledge/contracts";
import { PgBossJobQueue, retryOrganizationFailedProcessingJobs } from "@wknowledge/core";
import { getDatabase, schema } from "@wknowledge/database";
import { apiError } from "../../../../../lib/api";
import { settingsAdminMutation } from "../../../../../lib/settings-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const admin = await settingsAdminMutation(request, "settings.queue-health.redrive");
  if ("error" in admin) return admin.error;
  const parsed = redriveDeadLetterInputSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return apiError(400, "INPUT_INVALID", "重驱批次必须是 1 到 100 之间的整数");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    return apiError(
      503,
      "DEAD_LETTER_REDRIVE_FAILED",
      "失败任务暂时无法重新处理",
      "请检查系统运行配置后重试"
    );
  const queue = new PgBossJobQueue(connectionString);
  try {
    const result = await retryOrganizationFailedProcessingJobs(
      { organizationId: admin.organizationId, limit: parsed.data.limit },
      queue
    );
    await getDatabase()
      .insert(schema.auditEvents)
      .values({
        organizationId: admin.organizationId,
        actorUserId: admin.user.id,
        action: "queue.resource-process.retried",
        targetType: "queue",
        targetId: "resource.process",
        metadata: { requested: parsed.data.limit, moved: result.moved, skipped: result.skipped }
      });
    return Response.json(result);
  } catch {
    return apiError(
      503,
      "DEAD_LETTER_REDRIVE_FAILED",
      "失败任务暂时无法重新处理",
      "请稍后刷新任务队列后重试"
    );
  } finally {
    await queue.stop();
  }
}
