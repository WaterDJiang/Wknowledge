import { requestPlanComposeGenerationInputSchema } from "@wknowledge/contracts";
import { queuePlanComposeGeneration } from "@wknowledge/core";
import { getDatabase, schema } from "@wknowledge/database";
import { and, eq } from "drizzle-orm";
import { apiError, currentUser } from "../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";
import { getManagedSkill } from "../../../../../lib/settings";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "learning_plan.generate_candidate",
    { limit: 10, windowSeconds: 60 }
  );
  if (securityError) return securityError;
  const parsed = requestPlanComposeGenerationInputSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success)
    return apiError(
      400,
      "INPUT_INVALID",
      "学习目标或资料选择不正确",
      undefined,
      parsed.error.flatten()
    );
  const [membership] = await getDatabase()
    .select({ organizationId: schema.organizationMemberships.organizationId })
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.userId, user.id),
        eq(schema.organizationMemberships.disabled, false)
      )
    )
    .limit(1);
  if (!membership) return apiError(403, "ORGANIZATION_MEMBERSHIP_REQUIRED", "当前账号没有组织权限");
  const skill = await getManagedSkill(membership.organizationId, "plan-compose");
  if (!skill) return apiError(503, "SKILL_UNAVAILABLE", "计划生成 Skill 当前不可用");
  try {
    const run = await queuePlanComposeGeneration({ ...parsed.data, userId: user.id, skill });
    return Response.json({ run }, { status: 202 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "LEARNING_GENERATION_CREATE_FAILED";
    if (code === "LEARNING_GENERATION_SELECTION_DUPLICATE")
      return apiError(400, code, "学习资料不能重复选择");
    if (code === "LEARNING_GENERATION_SELECTION_DENIED")
      return apiError(403, code, "所选资料不存在、未完成处理或无权学习");
    if (code === "SKILL_POLICY_DENIED") return apiError(403, code, "计划生成 Skill 已被管理员停用");
    if (code === "AGENT_CONTEXT_ORGANIZATION_MISMATCH")
      return apiError(403, code, "一次生成只能选择同一组织内的资料");
    return apiError(503, "LEARNING_GENERATION_CREATE_FAILED", "计划候选暂时无法入队，请稍后重试");
  }
}
