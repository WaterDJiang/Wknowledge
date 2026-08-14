import { getActiveLearningCourse } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../lib/api";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  try {
    return Response.json({ course: await getActiveLearningCourse(user.id) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "LEARNING_COURSE_UNAVAILABLE";
    if (code === "LEARNING_PLAN_ACTIVE_NOT_FOUND") return apiError(404, code, "尚未确认学习计划");
    if (code === "LEARNING_COURSE_ACTIVE_NOT_FOUND")
      return apiError(409, code, "当前学习计划尚未完成课程编排");
    return apiError(503, "LEARNING_COURSE_UNAVAILABLE", "学习课程暂时无法读取，请稍后重试");
  }
}
