import { listPracticeGenerateCandidates } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../lib/api";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  try {
    return Response.json({ candidates: await listPracticeGenerateCandidates(user.id) });
  } catch (error) {
    const code =
      error instanceof Error ? error.message : "PRACTICE_GENERATE_CANDIDATES_READ_FAILED";
    if (code === "PRACTICE_GENERATE_CANDIDATE_INVALID")
      return apiError(409, code, "练习候选内容不完整，无法安全读取");
    return apiError(
      503,
      "PRACTICE_GENERATE_CANDIDATES_READ_FAILED",
      "练习候选暂时无法读取，请稍后重试"
    );
  }
}
