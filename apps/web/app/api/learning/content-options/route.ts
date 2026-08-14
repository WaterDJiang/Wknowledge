import { listLearningContentOptions } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../lib/api";

export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  return Response.json({ options: await listLearningContentOptions(user.id) });
}
