import { apiError, currentUser } from "../../../../../lib/api";

export const runtime = "nodejs";

export async function POST() {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  return apiError(
    410,
    "AGENT_MESSAGES_ENDPOINT_RETIRED",
    "此接口已停用",
    "请使用 /api/agent-sessions/{sessionId}/runs 获取可停止的事件流"
  );
}
