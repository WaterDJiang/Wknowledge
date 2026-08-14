import { readModelInvocationBudgetLimits } from "@wknowledge/core";
import { settingsAdmin } from "../../../../lib/settings-auth";

export const runtime = "nodejs";

export async function GET() {
  const admin = await settingsAdmin();
  if ("error" in admin) return admin.error;
  return Response.json({
    windowHours: 24,
    limits: readModelInvocationBudgetLimits()
  });
}
