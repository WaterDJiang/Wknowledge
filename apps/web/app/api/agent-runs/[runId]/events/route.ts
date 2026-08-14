import { getAgentRunEvents } from "@wknowledge/core";
import { apiError, currentUser } from "../../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function eventCursor(request: Request): number | null {
  const value = request.headers.get("last-event-id");
  if (value === null || value === "") return 0;
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : null;
}

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const afterSequence = eventCursor(request);
  if (afterSequence === null)
    return apiError(400, "AGENT_RUN_EVENT_CURSOR_INVALID", "事件续传位置不正确");
  const { runId } = await context.params;
  try {
    const events = await getAgentRunEvents({ runId, userId: user.id, afterSequence });
    const encoder = new TextEncoder();
    const body = events
      .map(
        (event) => `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      )
      .join("");
    return new Response(encoder.encode(body), {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "AGENT_RUN_EVENT_READ_FAILED";
    if (code === "AGENT_RUN_NOT_FOUND") return apiError(404, code, "运行不存在或无权查看");
    if (code === "AGENT_SESSION_ACCESS_REVOKED")
      return apiError(
        403,
        code,
        "运行关联的知识范围已撤销，历史事件已停止访问",
        "恢复相应知识空间权限，或新建仅包含当前可访问资料的会话"
      );
    return apiError(500, "AGENT_RUN_EVENT_READ_FAILED", "事件读取失败，请稍后重试");
  }
}
