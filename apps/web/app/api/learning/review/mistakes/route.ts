import { listActivePracticeMistakeReviews } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../lib/api";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  try {
    return Response.json({ items: await listActivePracticeMistakeReviews(user.id) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "PRACTICE_MISTAKE_REVIEW_UNAVAILABLE";
    if (code === "LEARNING_PLAN_ACTIVE_NOT_FOUND" || code === "LEARNING_COURSE_ACTIVE_NOT_FOUND")
      return apiError(404, code, "当前没有可查看的错题回顾");
    return apiError(503, "PRACTICE_MISTAKE_REVIEW_UNAVAILABLE", "错题回顾暂时无法读取，请稍后重试");
  }
}
