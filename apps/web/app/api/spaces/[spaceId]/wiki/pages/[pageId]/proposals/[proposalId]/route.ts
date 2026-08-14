import path from "node:path";
import { eq } from "drizzle-orm";
import { requireSpaceRole } from "@wknowledge/auth";
import { wikiProposalDecisionInputSchema } from "@wknowledge/contracts";
import { getDatabase, schema, withWikiPublicationLease } from "@wknowledge/database";
import { decideWikiPageProposal, getWikiPageChangeProposal } from "@wknowledge/wiki";
import { apiError, currentUser, dataRoot } from "../../../../../../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../../../../../../lib/request-security";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ spaceId: string; pageId: string; proposalId: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId, pageId, proposalId } = await context.params;
  if (!(await requireSpaceRole(user.id, spaceId, "editor")))
    return apiError(403, "SPACE_EDIT_DENIED", "无权查看待审核变更");

  try {
    const proposal = await getWikiPageChangeProposal(
      path.join(dataRoot(), spaceId),
      pageId,
      proposalId
    );
    if (!proposal) return apiError(404, "WIKI_PROPOSAL_NOT_FOUND", "待审核变更不存在");
    return Response.json({ proposal });
  } catch (error) {
    return apiError(
      500,
      "WIKI_PROPOSAL_READ_FAILED",
      "变更对比读取失败",
      "刷新页面后重试",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ spaceId: string; pageId: string; proposalId: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { spaceId, pageId, proposalId } = await context.params;
  const membership = await requireSpaceRole(user.id, spaceId, "editor");
  if (!membership) return apiError(403, "SPACE_EDIT_DENIED", "无权审核待发布变更");
  const securityError = await enforceAuthenticatedMutation(
    request,
    user.id,
    "wiki.proposal.decide"
  );
  if (securityError) return securityError;
  const parsed = wikiProposalDecisionInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "审核决定不正确", undefined, parsed.error.flatten());

  try {
    const db = getDatabase();
    const [space] = await db
      .select({ organizationId: schema.knowledgeSpaces.organizationId })
      .from(schema.knowledgeSpaces)
      .where(eq(schema.knowledgeSpaces.id, spaceId))
      .limit(1);
    if (!space) return apiError(404, "SPACE_NOT_FOUND", "知识空间不存在");
    const result = await withWikiPublicationLease(spaceId, "wiki.proposal", () =>
      decideWikiPageProposal(path.join(dataRoot(), spaceId), {
        pageId,
        proposalId,
        action: parsed.data.action,
        reviewerId: user.id
      })
    );
    await db.insert(schema.auditEvents).values({
      organizationId: space.organizationId,
      actorUserId: user.id,
      action:
        parsed.data.action === "accept"
          ? "wiki.page.proposal.accepted"
          : "wiki.page.proposal.rejected",
      targetType: "wiki_page",
      targetId: pageId,
      metadata: { spaceId, proposalId, baseDigest: result.proposal.baseDigest }
    });
    return Response.json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "WIKI_PAGE_NOT_FOUND" || code === "WIKI_PROPOSAL_NOT_FOUND")
      return apiError(404, code, "知识页面或待审核变更不存在", "刷新页面后重试");
    if (code === "WIKI_PROPOSAL_STATE_INVALID" || code === "WIKI_PROPOSAL_BASE_STALE")
      return apiError(409, code, "待审核变更已经过期", "刷新变更列表后重新对比");
    if (code === "WIKI_PUBLICATION_LOCKED" || code === "WIKI_PUBLICATION_LEASE_LOST")
      return apiError(409, code, "知识库正在发布其他变更", "稍后刷新页面后重试");
    return apiError(500, "WIKI_PROPOSAL_DECISION_FAILED", "审核决定保存失败", "刷新后重试", code);
  }
}
