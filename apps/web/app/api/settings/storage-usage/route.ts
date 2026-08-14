import { readOrganizationStorageUsage } from "@wknowledge/core";
import { apiError } from "../../../../lib/api";
import { settingsAdmin } from "../../../../lib/settings-auth";

export const runtime = "nodejs";

export async function GET() {
  const admin = await settingsAdmin();
  if ("error" in admin) return admin.error;
  try {
    return Response.json({ usage: await readOrganizationStorageUsage(admin.organizationId) });
  } catch {
    return apiError(
      503,
      "STORAGE_USAGE_UNAVAILABLE",
      "资料存储用量暂时不可用",
      "请检查数据库连接后重试"
    );
  }
}
