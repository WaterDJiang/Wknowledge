import { auditExportInputSchema } from "@wknowledge/contracts";
import { exportOrganizationAuditEvents, resolveAuditExportRange } from "@wknowledge/core";
import { getDatabase, schema } from "@wknowledge/database";
import { apiError } from "../../../../lib/api";
import { settingsAdmin } from "../../../../lib/settings-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const admin = await settingsAdmin();
  if ("error" in admin) return admin.error;
  const url = new URL(request.url);
  const parsed = auditExportInputSchema.safeParse({
    ...(url.searchParams.has("from") ? { from: url.searchParams.get("from") } : {}),
    ...(url.searchParams.has("to") ? { to: url.searchParams.get("to") } : {}),
    ...(url.searchParams.has("limit") ? { limit: url.searchParams.get("limit") } : {})
  });
  if (!parsed.success)
    return apiError(400, "AUDIT_EXPORT_INPUT_INVALID", "导出时间范围或数量不正确");
  let range;
  try {
    range = resolveAuditExportRange({
      ...(parsed.data.from ? { from: parsed.data.from } : {}),
      ...(parsed.data.to ? { to: parsed.data.to } : {})
    });
  } catch {
    return apiError(
      400,
      "AUDIT_EXPORT_RANGE_INVALID",
      "导出时间范围不正确",
      "请选择不超过 31 天的时间范围"
    );
  }
  try {
    const events = await exportOrganizationAuditEvents({
      organizationId: admin.organizationId,
      range,
      limit: parsed.data.limit
    });
    await getDatabase()
      .insert(schema.auditEvents)
      .values({
        organizationId: admin.organizationId,
        actorUserId: admin.user.id,
        action: "audit.exported",
        targetType: "organization",
        targetId: admin.organizationId,
        metadata: {
          count: events.length,
          from: range.from.toISOString(),
          to: range.to.toISOString()
        }
      });
    const filename = `wknowledge-audit-${range.to.toISOString().slice(0, 10)}.json`;
    return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), events }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store"
      }
    });
  } catch {
    return apiError(503, "AUDIT_EXPORT_UNAVAILABLE", "审计导出暂时不可用", "请稍后重试");
  }
}
