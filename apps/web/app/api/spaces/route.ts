import { and, eq } from "drizzle-orm";
import { createSpaceInputSchema } from "@wknowledge/contracts";
import { createSpace, listSpaces } from "@wknowledge/core";
import { getDatabase, schema } from "@wknowledge/database";
import { apiError, currentUser, dataRoot } from "../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../lib/request-security";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  return Response.json({ spaces: await listSpaces(user.id) });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(request, user.id, "space.create");
  if (securityError) return securityError;
  const parsed = createSpaceInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "空间信息不完整", undefined, parsed.error.flatten());
  const [organization] = await getDatabase()
    .select()
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.userId, user.id),
        eq(schema.organizationMemberships.disabled, false)
      )
    )
    .limit(1);
  if (!organization) return apiError(403, "ORG_ACCESS_DENIED", "当前用户不属于任何组织");
  const space = await createSpace({
    organizationId: organization.organizationId,
    userId: user.id,
    name: parsed.data.name,
    description: parsed.data.description,
    dataPolicy: parsed.data.dataPolicy,
    dataRoot: dataRoot()
  });
  return Response.json({ space }, { status: 201 });
}
