import { listLearningReportSnapshots } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../lib/api";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  try {
    return Response.json({ snapshots: await listLearningReportSnapshots({ userId: user.id }) });
  } catch {
    return apiError(
      503,
      "LEARNING_REPORT_SNAPSHOTS_UNAVAILABLE",
      "历史报告暂时无法读取，请稍后重试"
    );
  }
}
