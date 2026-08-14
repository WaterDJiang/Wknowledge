import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { queryInputSchema } from "@wknowledge/contracts";
import { runKnowledgeAgent, toQueryRunAudit } from "@wknowledge/agent-runtime";
import { getDatabase, schema } from "@wknowledge/database";
import { apiError, currentUser, dataRoot } from "../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";
import { persistQueryRun } from "../../../../../lib/query-runs";
import { createManagedChatGateway, isManagedSkillEnabled } from "../../../../../lib/settings";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ spaceId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId } = await context.params;
  if (!(await requireSpaceRole(user.id, spaceId, "viewer")))
    return apiError(403, "SPACE_ACCESS_DENIED", "无权查询该知识空间");
  const securityError = await enforceAuthenticatedMutation(request, user.id, "knowledge.query", {
    limit: 30,
    windowSeconds: 60
  });
  if (securityError) return securityError;
  const parsed = queryInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "问题格式不正确", undefined, parsed.error.flatten());
  try {
    const [space] = await getDatabase()
      .select({
        dataPolicy: schema.knowledgeSpaces.dataPolicy,
        organizationId: schema.knowledgeSpaces.organizationId
      })
      .from(schema.knowledgeSpaces)
      .where(eq(schema.knowledgeSpaces.id, spaceId))
      .limit(1);
    if (!space) return apiError(404, "SPACE_NOT_FOUND", "知识空间不存在");
    if (!(await isManagedSkillEnabled(space.organizationId, "wiki-query")))
      return apiError(
        409,
        "SKILL_DISABLED",
        "知识问答 Skill 已停用",
        "前往系统设置重新启用 wiki-query"
      );
    const startedAt = Date.now();
    const run = await runKnowledgeAgent(
      randomUUID(),
      path.join(dataRoot(), spaceId),
      parsed.data.question,
      {
        gateway: await createManagedChatGateway(space.organizationId, user.id),
        dataPolicy: space.dataPolicy
      }
    );
    try {
      await persistQueryRun({
        organizationId: space.organizationId,
        spaceId,
        userId: user.id,
        audit: toQueryRunAudit(run, parsed.data.question, Date.now() - startedAt)
      });
    } catch {
      return apiError(
        500,
        "QUERY_AUDIT_FAILED",
        "知识问答运行记录保存失败",
        "请稍后重试；本次回答未作为成功结果返回"
      );
    }
    return Response.json(run);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return apiError(409, "WIKI_NOT_READY", "知识库尚未完成发布", "等待资料处理完成后再重试");
    if (
      error instanceof Error &&
      ["MODEL_BUDGET_EXCEEDED", "MODEL_PROVIDER_BUDGET_EXCEEDED"].includes(error.message)
    )
      return apiError(
        429,
        "MODEL_BUDGET_EXCEEDED",
        "今日模型调用额度已用尽",
        "请明日再试，或联系管理员调整模型调用额度"
      );
    return apiError(500, "QUERY_FAILED", "知识检索暂时不可用", "稍后重试或检查 Wiki 状态");
  }
}
