import { materializePlanComposeCandidateInputSchema } from "@wknowledge/contracts";
import { materializePlanComposeCandidate } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../../lib/request-security";

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
    "learning_plan.materialize_candidate",
    { limit: 20, windowSeconds: 60 }
  );
  if (securityError) return securityError;
  const { candidateId } = await context.params;
  const parsed = materializePlanComposeCandidateInputSchema.safeParse({
    ...(await request.json().catch(() => null)),
    candidateId
  });
  if (!parsed.success)
    return apiError(
      400,
      "INPUT_INVALID",
      "计划候选确认内容不正确",
      undefined,
      parsed.error.flatten()
    );
  try {
    return Response.json(
      { plan: await materializePlanComposeCandidate({ ...parsed.data, userId: user.id }) },
      { status: 201 }
    );
  } catch (error) {
    const code =
      error instanceof Error ? error.message : "PLAN_COMPOSE_CANDIDATE_MATERIALIZE_FAILED";
    if (code === "LEARNING_PLAN_SELECTION_DUPLICATE")
      return apiError(400, code, "学习内容不能重复选择");
    if (code === "LEARNING_PLAN_SELECTION_DENIED")
      return apiError(403, code, "所选资料不存在、未完成处理或无权学习");
    if (code === "PLAN_COMPOSE_SCOPE_DENIED" || code === "PLAN_COMPOSE_SCOPE_REVOKED")
      return apiError(403, code, "候选的知识范围已变更或不再有权使用");
    if (code === "PLAN_COMPOSE_CANDIDATE_ALREADY_MATERIALIZED")
      return apiError(409, code, "该计划候选已经生成草稿，不能重复使用");
    if (code === "PLAN_COMPOSE_SKILL_RUN_DENIED")
      return apiError(403, code, "计划候选的运行记录不可用或无权访问");
    if (
      code === "PLAN_COMPOSE_CANDIDATE_INVALID" ||
      code === "PLAN_COMPOSE_UNIT_SELECTION_DENIED" ||
      code === "PLAN_COMPOSE_UNIT_SELECTION_INCOMPLETE" ||
      code === "PLAN_COMPOSE_UNIT_SOURCE_DENIED"
    )
      return apiError(409, code, "计划候选未通过来源或内容校验，未创建草稿");
    return apiError(
      500,
      "PLAN_COMPOSE_CANDIDATE_MATERIALIZE_FAILED",
      "创建计划草稿失败，请稍后重试"
    );
  }
}
