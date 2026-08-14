import { createActiveLearningReportSnapshot } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../../lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "learning_report.snapshot.create",
    { limit: 12, windowSeconds: 60 }
  );
  if (securityError) return securityError;
  try {
    return Response.json(
      { snapshot: await createActiveLearningReportSnapshot(user.id) },
      { status: 202 }
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "LEARNING_REPORT_SNAPSHOT_UNAVAILABLE";
    if (code === "LEARNING_PLAN_ACTIVE_NOT_FOUND" || code === "LEARNING_COURSE_ACTIVE_NOT_FOUND")
      return apiError(409, code, "请先确认一个可学习的计划");
    return apiError(
      503,
      "LEARNING_REPORT_SNAPSHOT_UNAVAILABLE",
      "报告快照暂时无法创建，请稍后重试"
    );
  }
}
