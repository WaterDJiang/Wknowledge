import { requestPracticeGenerateInputSchema } from "@wknowledge/contracts";
import { queuePracticeGenerateGeneration } from "@wknowledge/core";
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
    "practice.generate_candidate",
    { limit: 10, windowSeconds: 60 }
  );
  if (securityError) return securityError;
  const parsed = requestPracticeGenerateInputSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success)
    return apiError(
      400,
      "INPUT_INVALID",
      "练习范围或难度不正确",
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
  const skill = await getManagedSkill(membership.organizationId, "practice-generate");
  if (!skill) return apiError(503, "SKILL_UNAVAILABLE", "练习生成 Skill 当前不可用");
  try {
    return Response.json(
      { run: await queuePracticeGenerateGeneration({ ...parsed.data, userId: user.id, skill }) },
      { status: 202 }
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "PRACTICE_GENERATE_CREATE_FAILED";
    if (code === "PRACTICE_GENERATE_SELECTION_DUPLICATE")
      return apiError(400, code, "练习单元不能重复选择");
    if (
      [
        "PRACTICE_GENERATE_COURSE_UNIT_DENIED",
        "PRACTICE_GENERATE_COURSE_UNIT_NOT_COMPLETED"
      ].includes(code)
    )
      return apiError(403, code, "只能选择当前课程中已经完成的学习单元");
    return apiError(503, "PRACTICE_GENERATE_CREATE_FAILED", "练习候选暂时无法入队，请稍后重试");
  }
}
