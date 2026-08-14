import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import {
  exportOrganizationAuditEvents,
  readAuditRetentionDays,
  resolveAuditExportRange
} from "../src";

const test = process.env.DATABASE_URL ? it : it.skip;
const organizationIds: string[] = [];

afterAll(async () => {
  if (organizationIds.length)
    await getDatabase()
      .delete(schema.organizations)
      .where(inArray(schema.organizations.id, organizationIds));
  await closeDatabase();
});

describe("audit export", () => {
  it("uses a 24 hour default range and rejects ranges over 31 days", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(resolveAuditExportRange({ now })).toEqual({
      from: new Date("2026-08-13T12:00:00.000Z"),
      to: now
    });
    expect(() =>
      resolveAuditExportRange({
        now,
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-08-14T00:00:00.000Z"
      })
    ).toThrow("AUDIT_EXPORT_RANGE_INVALID");
    expect(readAuditRetentionDays({ WKNOWLEDGE_AUDIT_RETENTION_DAYS: "120" })).toBe(120);
    expect(readAuditRetentionDays({ WKNOWLEDGE_AUDIT_RETENTION_DAYS: "0" })).toBeNull();
  });

  test("exports only the selected organization and omits event metadata", async () => {
    const organizationId = randomUUID();
    const otherOrganizationId = randomUUID();
    organizationIds.push(organizationId, otherOrganizationId);
    const db = getDatabase();
    await db.insert(schema.organizations).values([
      { id: organizationId, name: "audit export own" },
      { id: otherOrganizationId, name: "audit export other" }
    ]);
    await db.insert(schema.auditEvents).values([
      {
        organizationId,
        action: "resource.processed",
        targetType: "resource_version",
        targetId: randomUUID(),
        metadata: { secret: "never-export", source: "wk://source/private" }
      },
      {
        organizationId: otherOrganizationId,
        action: "other.organization.event",
        targetType: "resource_version",
        targetId: randomUUID(),
        metadata: { secret: "other-secret" }
      }
    ]);
    const events = await exportOrganizationAuditEvents({
      organizationId,
      range: {
        from: new Date(Date.now() - 60_000),
        to: new Date(Date.now() + 60_000)
      },
      limit: 100
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "resource.processed", actorUserId: null });
    expect(events[0]).not.toHaveProperty("metadata");
    expect(JSON.stringify(events)).not.toContain("never-export");
    expect(JSON.stringify(events)).not.toContain("wk://source");
  });
});
