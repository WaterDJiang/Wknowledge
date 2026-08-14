import { and, desc, eq, gte, lte } from "drizzle-orm";
import { auditExportRecordSchema, type AuditExportRecord } from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";

const DEFAULT_RANGE_MS = 24 * 60 * 60 * 1_000;
const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1_000;

export interface AuditExportRange {
  from: Date;
  to: Date;
}

export function resolveAuditExportRange(input: {
  from?: string;
  to?: string;
  now?: Date;
}): AuditExportRange {
  const now = input.now ?? new Date();
  const to = input.to ? new Date(input.to) : now;
  const from = input.from ? new Date(input.from) : new Date(to.getTime() - DEFAULT_RANGE_MS);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()))
    throw new Error("AUDIT_EXPORT_RANGE_INVALID");
  if (from.getTime() >= to.getTime() || to.getTime() - from.getTime() > MAX_RANGE_MS)
    throw new Error("AUDIT_EXPORT_RANGE_INVALID");
  return { from, to };
}

export function readAuditRetentionDays(
  environment: NodeJS.ProcessEnv = process.env
): number | null {
  const value = environment.WKNOWLEDGE_AUDIT_RETENTION_DAYS?.trim();
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3_650 ? parsed : null;
}

export async function exportOrganizationAuditEvents(input: {
  organizationId: string;
  range: AuditExportRange;
  limit: number;
}): Promise<AuditExportRecord[]> {
  const rows = await getDatabase()
    .select({
      id: schema.auditEvents.id,
      occurredAt: schema.auditEvents.createdAt,
      action: schema.auditEvents.action,
      targetType: schema.auditEvents.targetType,
      targetId: schema.auditEvents.targetId,
      actorUserId: schema.auditEvents.actorUserId
    })
    .from(schema.auditEvents)
    .where(
      and(
        eq(schema.auditEvents.organizationId, input.organizationId),
        gte(schema.auditEvents.createdAt, input.range.from),
        lte(schema.auditEvents.createdAt, input.range.to)
      )
    )
    .orderBy(desc(schema.auditEvents.createdAt))
    .limit(input.limit);
  return rows.map((row) =>
    auditExportRecordSchema.parse({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      actorUserId: row.actorUserId
    })
  );
}
