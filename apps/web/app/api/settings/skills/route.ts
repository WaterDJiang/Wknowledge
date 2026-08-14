import { settingsAdmin } from "../../../../lib/settings-auth";
import { listManagedSkills } from "../../../../lib/settings";

export const runtime = "nodejs";

export async function GET() {
  const admin = await settingsAdmin();
  if ("error" in admin) return admin.error;
  return Response.json({ skills: await listManagedSkills(admin.organizationId) });
}
