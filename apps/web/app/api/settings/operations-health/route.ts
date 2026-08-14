import {
  assessOrganizationOperationsAlerts,
  readOrganizationOperationsSnapshot
} from "@wknowledge/core";
import { apiError } from "../../../../lib/api";
import { settingsAdmin } from "../../../../lib/settings-auth";

export const runtime = "nodejs";

export async function GET() {
  const admin = await settingsAdmin();
  if ("error" in admin) return admin.error;
  try {
    const snapshot = await readOrganizationOperationsSnapshot(admin.organizationId);
    return Response.json({ snapshot, alerts: assessOrganizationOperationsAlerts(snapshot) });
  } catch {
    return apiError(
      503,
      "OPERATIONS_HEALTH_UNAVAILABLE",
      "系统运行状态暂时不可用",
      "请检查数据库连接后重试"
    );
  }
}
