import { createAssessmentFromPracticeGenerateCandidate } from "@wknowledge/core";
import { materializePracticeGenerateCandidateInputSchema } from "@wknowledge/contracts";
import { apiError, currentUser } from "../../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../../lib/request-security";
import { presentAssessmentError } from "../../../assessments/assessment-error";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ candidateId: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "assessment.create_from_skill_candidate",
    { limit: 20, windowSeconds: 60 }
  );
  if (securityError) return securityError;
  const parsed = materializePracticeGenerateCandidateInputSchema.safeParse({
    candidateId: (await context.params).candidateId
  });
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "练习候选标识不正确", undefined, parsed.error.flatten());
  try {
    return Response.json(
      {
        assessment: await createAssessmentFromPracticeGenerateCandidate({
          userId: user.id,
          candidateId: parsed.data.candidateId
        })
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === "ASSESSMENT_SKILL_CANDIDATE_DENIED")
      return apiError(404, "ASSESSMENT_SKILL_CANDIDATE_DENIED", "Skill 测评候选不存在或无权访问");
    if (
      error instanceof Error &&
      [
        "PRACTICE_GENERATE_SKILL_RUN_DENIED",
        "PRACTICE_GENERATE_SCOPE_DENIED",
        "PRACTICE_GENERATE_SCOPE_REVOKED",
        "PRACTICE_GENERATE_COURSE_DENIED"
      ].includes(error.message)
    )
      return apiError(403, error.message, "该 Skill 候选不在当前课程或知识范围内");
    if (
      error instanceof Error &&
      [
        "PRACTICE_GENERATE_COURSE_UNIT_NOT_COMPLETED",
        "PRACTICE_GENERATE_QUESTION_DUPLICATE",
        "PRACTICE_GENERATE_SOURCE_DENIED",
        "PRACTICE_GENERATE_CANDIDATE_INVALID"
      ].includes(error.message)
    )
      return apiError(409, error.message, "Skill 候选已过期或不符合当前学习范围");
    return presentAssessmentError(error);
  }
}
