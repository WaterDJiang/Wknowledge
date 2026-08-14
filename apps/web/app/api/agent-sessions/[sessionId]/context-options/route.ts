import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { getAgentSessionDetail } from "@wknowledge/core";
import { getDatabase, schema } from "@wknowledge/database";
import { listWikiPages } from "@wknowledge/wiki";
import { apiError, currentUser, dataRoot } from "../../../../../lib/api";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { sessionId } = await context.params;
  const spaceId = new URL(request.url).searchParams.get("spaceId");
  if (!spaceId || !/^[0-9a-f-]{36}$/i.test(spaceId))
    return apiError(400, "INPUT_INVALID", "知识空间标识不正确");
  if (!(await requireSpaceRole(user.id, spaceId, "viewer")))
    return apiError(403, "SPACE_ACCESS_DENIED", "无权查看该知识空间");
  try {
    await getAgentSessionDetail(sessionId, user.id);
    const [pages, versions, courses] = await Promise.all([
      listWikiPages(path.join(dataRoot(), spaceId)),
      getDatabase()
        .select({
          id: schema.resourceVersions.id,
          version: schema.resourceVersions.version,
          name: schema.resources.name,
          originalName: schema.resourceVersions.originalName
        })
        .from(schema.resourceVersions)
        .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
        .innerJoin(
          schema.processingJobs,
          eq(schema.processingJobs.resourceVersionId, schema.resourceVersions.id)
        )
        .where(
          and(eq(schema.resources.spaceId, spaceId), eq(schema.processingJobs.status, "completed"))
        )
        .groupBy(
          schema.resourceVersions.id,
          schema.resourceVersions.version,
          schema.resources.name,
          schema.resourceVersions.originalName
        )
        .orderBy(asc(schema.resources.name), asc(schema.resourceVersions.version)),
      getDatabase()
        .select({ id: schema.courses.id, label: schema.courses.title })
        .from(schema.courses)
        .innerJoin(schema.learningPlans, eq(schema.courses.learningPlanId, schema.learningPlans.id))
        .innerJoin(
          schema.learnerProfiles,
          eq(schema.learningPlans.learnerProfileId, schema.learnerProfiles.id)
        )
        .innerJoin(schema.courseModules, eq(schema.courseModules.courseId, schema.courses.id))
        .innerJoin(
          schema.courseUnits,
          eq(schema.courseUnits.courseModuleId, schema.courseModules.id)
        )
        .innerJoin(
          schema.resourceVersions,
          eq(schema.courseUnits.resourceVersionId, schema.resourceVersions.id)
        )
        .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
        .where(
          and(
            eq(schema.learnerProfiles.userId, user.id),
            eq(schema.learningPlans.status, "active"),
            eq(schema.courses.status, "active"),
            eq(schema.resources.spaceId, spaceId)
          )
        )
        .groupBy(schema.courses.id, schema.courses.title)
        .orderBy(asc(schema.courses.title))
    ]);
    return Response.json({
      pages: pages.map(({ id, title, type }) => ({ id, title, type })),
      versions: versions.map((version) => ({
        id: version.id,
        label: `${version.name} · v${version.version}`,
        originalName: version.originalName
      })),
      courses
    });
  } catch (error) {
    if (error instanceof Error && error.message === "AGENT_SESSION_NOT_FOUND")
      return apiError(404, "AGENT_SESSION_NOT_FOUND", "会话不存在或无权访问");
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return apiError(409, "WIKI_NOT_READY", "该知识空间尚未完成 Wiki 发布");
    return apiError(500, "AGENT_CONTEXT_OPTIONS_FAILED", "知识范围候选读取失败，请稍后重试");
  }
}
