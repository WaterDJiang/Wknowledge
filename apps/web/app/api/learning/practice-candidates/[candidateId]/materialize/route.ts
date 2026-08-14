import { materializePracticeGenerateCandidateInputSchema } from "@wknowledge/contracts";
import { materializePracticeGenerateCandidate } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../../lib/request-security";

export const runtime = "nodejs";

function presentError(error: unknown) {
  const code = error instanceof Error ? error.message : "PRACTICE_GENERATE_UNAVAILABLE";
  if (code === "LEARNING_PLAN_ACTIVE_NOT_FOUND")
    return apiError(409, code, "请先确认包含学习资料的计划");
  if (code === "LEARNING_COURSE_ACTIVE_NOT_FOUND")
    return apiError(409, code, "当前计划尚未完成课程编排，请重新生成计划");
  if (
    [
      "PRACTICE_GENERATE_SKILL_RUN_DENIED",
      "PRACTICE_GENERATE_SCOPE_DENIED",
      "PRACTICE_GENERATE_SCOPE_REVOKED",
      "PRACTICE_GENERATE_COURSE_DENIED"
    ].includes(code)
  )
    return apiError(403, code, "该练习候选不在当前课程或知识范围内");
  if (
    [
      "PRACTICE_GENERATE_CANDIDATE_ALREADY_MATERIALIZED",
      "PRACTICE_GENERATE_COURSE_UNIT_NOT_COMPLETED",
      "PRACTICE_GENERATE_QUESTION_DUPLICATE",
      "PRACTICE_GENERATE_SOURCE_DENIED",
      "PRACTICE_GENERATE_CANDIDATE_INVALID"
    ].includes(code)
  )
    return apiError(409, code, "练习候选已过期或不符合当前学习范围");
  return apiError(503, "PRACTICE_GENERATE_UNAVAILABLE", "练习候选暂时无法处理，请稍后重试");
}

export async function POST(
  request: Request,
  context: { params: Promise<{ candidateId: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "practice.candidate.materialize",
    { limit: 20, windowSeconds: 60 }
  );
  if (securityError) return securityError;
  const { candidateId } = await context.params;
  const parsed = materializePracticeGenerateCandidateInputSchema.safeParse({ candidateId });
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "练习候选标识不正确", undefined, parsed.error.flatten());
  try {
    return Response.json(
      {
        candidate: await materializePracticeGenerateCandidate({ ...parsed.data, userId: user.id })
      },
      { status: 201 }
    );
  } catch (error) {
    return presentError(error);
  }
}
