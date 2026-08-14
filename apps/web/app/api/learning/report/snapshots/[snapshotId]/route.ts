import { getLearningReportSnapshot } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../../lib/api";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ snapshotId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  try {
    return Response.json({
      snapshot: await getLearningReportSnapshot({
        snapshotId: (await context.params).snapshotId,
        userId: user.id
      })
    });
  } catch (error) {
    if (error instanceof Error && error.message === "LEARNING_REPORT_SNAPSHOT_NOT_FOUND")
      return apiError(404, "LEARNING_REPORT_SNAPSHOT_NOT_FOUND", "报告不存在或无权查看");
    return apiError(503, "LEARNING_REPORT_SNAPSHOT_UNAVAILABLE", "报告暂时无法读取，请稍后重试");
  }
}
