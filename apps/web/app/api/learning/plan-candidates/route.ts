import { listPlanComposeCandidates } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../lib/api";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  try {
    return Response.json({ candidates: await listPlanComposeCandidates(user.id) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "PLAN_COMPOSE_CANDIDATES_READ_FAILED";
    if (code === "PLAN_COMPOSE_CANDIDATE_INVALID")
      return apiError(409, code, "计划候选内容不完整，无法安全读取");
    return apiError(503, "PLAN_COMPOSE_CANDIDATES_READ_FAILED", "计划候选暂时无法读取，请稍后重试");
  }
}
