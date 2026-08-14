import { requireSpaceRole } from "@wknowledge/auth";
import { recompileResourceInputSchema } from "@wknowledge/contracts";
import { PgBossJobQueue, recompileResourceVersion } from "@wknowledge/core";
import { getDatabase, schema } from "@wknowledge/database";
import { eq } from "drizzle-orm";
import { apiError, currentUser } from "../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ resourceId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { resourceId } = await context.params;
  const [resource] = await getDatabase()
    .select()
    .from(schema.resources)
    .where(eq(schema.resources.id, resourceId))
    .limit(1);
  if (!resource) return apiError(404, "RESOURCE_NOT_FOUND", "资料不存在");
  if (!(await requireSpaceRole(user.id, resource.spaceId, "editor")))
    return apiError(403, "SPACE_ACCESS_DENIED", "需要编辑权限");
  const securityError = await enforceAuthenticatedMutation(request, user.id, "resource.recompile", {
    limit: 20,
    windowSeconds: 60
  });
  if (securityError) return securityError;
  const parsed = recompileResourceInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "RECOMPILE_PROFILE_INVALID", "请选择有效的知识整理模式");
  const queue = new PgBossJobQueue(process.env.DATABASE_URL ?? "");
  try {
    const result = await recompileResourceVersion(
      {
        resourceId: resource.id,
        spaceId: resource.spaceId,
        userId: user.id,
        compileProfile: parsed.data.compileProfile
      },
      queue
    );
    return Response.json(result, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "RESOURCE_RECOMPILE_FAILED";
    if (code === "RESOURCE_VERSION_NOT_FOUND")
      return apiError(409, code, "资料尚无可重新整理的版本");
    return apiError(500, "RESOURCE_RECOMPILE_FAILED", "重新整理资料失败，请稍后重试");
  } finally {
    await queue.stop();
  }
}
