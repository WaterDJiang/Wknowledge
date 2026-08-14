import { listManualFreeResponseReviews } from "@wknowledge/core";
import { apiError } from "../../../../../lib/api";
import { settingsAdmin } from "../../../../../lib/settings-auth";

export const runtime = "nodejs";

export async function GET() {
  const admin = await settingsAdmin();
  if ("error" in admin) return admin.error;
  try {
    return Response.json({ items: await listManualFreeResponseReviews(admin.organizationId) });
  } catch {
    return apiError(503, "MANUAL_REVIEW_UNAVAILABLE", "人工复核队列暂时无法读取，请稍后重试");
  }
}
