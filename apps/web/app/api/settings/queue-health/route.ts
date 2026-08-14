import { readOrganizationResourceQueueHealth } from "@wknowledge/core";
import { apiError } from "../../../../lib/api";
import { settingsAdmin } from "../../../../lib/settings-auth";

export const runtime = "nodejs";

export async function GET() {
  const admin = await settingsAdmin();
  if ("error" in admin) return admin.error;
  try {
    return Response.json({
      health: await readOrganizationResourceQueueHealth(admin.organizationId)
    });
  } catch {
    return apiError(503, "QUEUE_HEALTH_UNAVAILABLE", "任务队列暂时不可用", "请稍后刷新重试");
  }
}
