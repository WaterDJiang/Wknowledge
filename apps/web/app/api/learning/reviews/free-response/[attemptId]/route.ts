import { submitManualFreeResponseReviewInputSchema } from "@wknowledge/contracts";
import { submitManualFreeResponseReview } from "@wknowledge/core";
import { apiError } from "../../../../../../lib/api";
import { settingsAdminMutation } from "../../../../../../lib/settings-auth";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ attemptId: string }> }) {
  const admin = await settingsAdminMutation(request, "learning.free-response.review");
  if ("error" in admin) return admin.error;
  const parsed = submitManualFreeResponseReviewInputSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "人工评分内容不正确", undefined, parsed.error.flatten());
  try {
    const result = await submitManualFreeResponseReview({
      ...parsed.data,
      attemptId: (await context.params).attemptId,
      organizationId: admin.organizationId,
      reviewerUserId: admin.user.id
    });
    return Response.json({
      review: {
        attemptType: result.attemptType,
        attemptId: result.attemptId,
        grade: {
          id: result.grade.id,
          grader: "human_review",
          ruleVersion: "manual_rubric.v1",
          score: result.grade.score,
          maximumScore: result.grade.maximumScore,
          correct: result.grade.correct,
          rationale: result.grade.rationale,
          reviewedBy: result.grade.reviewerUserId,
          createdAt: result.grade.createdAt.toISOString()
        }
      }
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "MANUAL_REVIEW_UNAVAILABLE";
    if (code === "MANUAL_REVIEW_ATTEMPT_NOT_FOUND")
      return apiError(404, code, "待复核作答不存在或不属于当前组织");
    if (code === "MANUAL_REVIEW_ALREADY_GRADED")
      return apiError(409, code, "该作答已经评分，不能覆盖历史成绩");
    if (code === "MANUAL_REVIEW_ATTEMPT_NOT_ELIGIBLE")
      return apiError(409, code, "只有待复核的自由作答可以人工评分");
    if (code === "MANUAL_REVIEW_SCORE_INVALID")
      return apiError(400, code, "分数不能超过冻结量表的满分");
    return apiError(503, "MANUAL_REVIEW_UNAVAILABLE", "人工评分暂时无法保存，请稍后重试");
  }
}
