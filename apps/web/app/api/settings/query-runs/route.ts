import { queryRunListInputSchema } from "@wknowledge/contracts";
import { apiError } from "../../../../lib/api";
import { listManagedQueryRuns } from "../../../../lib/query-runs";
import { settingsAdmin } from "../../../../lib/settings-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const admin = await settingsAdmin();
  if ("error" in admin) return admin.error;
  const parsed = queryRunListInputSchema.safeParse({
    limit: new URL(request.url).searchParams.get("limit") ?? undefined
  });
  if (!parsed.success)
    return apiError(
      400,
      "INPUT_INVALID",
      "运行记录筛选条件不正确",
      undefined,
      parsed.error.flatten()
    );
  return Response.json({
    runs: await listManagedQueryRuns(admin.organizationId, parsed.data.limit)
  });
}
