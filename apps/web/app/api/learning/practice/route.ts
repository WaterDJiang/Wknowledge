import { createPracticeCandidateInputSchema } from "@wknowledge/contracts";
import { createPracticeCandidate, listPracticeCandidates } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../lib/request-security";

export const runtime = "nodejs";

function presentError(error: unknown) {
  const code = error instanceof Error ? error.message : "PRACTICE_UNAVAILABLE";
  if (code === "LEARNING_PLAN_ACTIVE_NOT_FOUND")
    return apiError(409, code, "请先确认包含学习资料的计划");
  if (code === "LEARNING_COURSE_ACTIVE_NOT_FOUND")
    return apiError(409, code, "当前计划尚未完成课程编排，请重新生成计划");
  if (code === "PRACTICE_COURSE_UNIT_DUPLICATE") return apiError(400, code, "练习单元不能重复选择");
  if (code === "PRACTICE_COURSE_UNIT_DENIED")
    return apiError(403, code, "所选学习单元不属于当前课程");
  if (code === "PRACTICE_COURSE_UNIT_NOT_COMPLETED")
    return apiError(409, code, "请先完成原文学习后再生成练习");
  if (code === "PRACTICE_SOURCE_REVOKED")
    return apiError(409, code, "其中资料已不可学习，请联系空间管理员");
  return apiError(503, "PRACTICE_UNAVAILABLE", "练习候选暂时无法处理，请稍后重试");
}

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  try {
    return Response.json({ candidates: await listPracticeCandidates(user.id) });
  } catch (error) {
    return presentError(error);
  }
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "practice.candidate.create",
    {
      limit: 20,
      windowSeconds: 60
    }
  );
  if (securityError) return securityError;
  const parsed = createPracticeCandidateInputSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "练习候选内容不正确", undefined, parsed.error.flatten());
  try {
    return Response.json(
      { candidate: await createPracticeCandidate({ ...parsed.data, userId: user.id }) },
      { status: 201 }
    );
  } catch (error) {
    return presentError(error);
  }
}
