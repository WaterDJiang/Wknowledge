import { LocalBlobStore } from "@wknowledge/blob-store";
import { auditLocalBlobConsistency } from "@wknowledge/core";
import { apiError, blobRoot } from "../../../../lib/api";
import { settingsAdmin } from "../../../../lib/settings-auth";

export const runtime = "nodejs";

export async function GET() {
  const admin = await settingsAdmin();
  if ("error" in admin) return admin.error;
  try {
    return Response.json({
      audit: await auditLocalBlobConsistency({
        organizationId: admin.organizationId,
        blobStore: new LocalBlobStore(blobRoot())
      })
    });
  } catch {
    return apiError(
      503,
      "BLOB_AUDIT_UNAVAILABLE",
      "资料存储巡检暂时不可用",
      "请检查本地存储和数据库连接后重试"
    );
  }
}
