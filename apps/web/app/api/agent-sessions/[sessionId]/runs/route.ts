import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  agentRunStreamEventSchema,
  createAgentMessageInputSchema,
  groundedQueryResultSchema
} from "@wknowledge/contracts";
import { runBoundKnowledgeAgent, runPiKnowledgeTurn } from "@wknowledge/agent-runtime";
import { getWikiPage } from "@wknowledge/wiki";
import {
  beginAgentSessionRun,
  completeAgentSessionRun,
  assertAgentSessionBindingsReadable,
  recordAgentLoopRouting,
  resolveAgentSessionContext,
  settleAgentSessionRun,
  stopAgentSessionRun
} from "@wknowledge/core";
import { apiError, currentUser, dataRoot } from "../../../../../lib/api";
import {
  knowledgeToolCallRecords,
  piSessionComponent,
  piSessionPolicyBridge,
  piToolStreamEvents,
  resolveServerAgentLoop
} from "../../../../../lib/pi-agent-turn";
import {
  clearAgentRunStream,
  registerAgentRunStream,
  sseEvent,
  stopActiveAgentRunStream
} from "../../../../../lib/agent-run-stream";
import { enforceAuthenticatedMutation } from "../../../../../lib/request-security";
import { createManagedChatGateway, isManagedSkillEnabled } from "../../../../../lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pi is the normal server entrypoint. `internal` is an explicit, audited
// incident rollback only; local SQLite App selection never reaches this route.
const SERVER_AGENT_LOOP = resolveServerAgentLoop(process.env.WKNOWLEDGE_AGENT_LOOP);

function strictestDataPolicy(
  policies: Array<"local_only" | "cloud_allowed" | "cloud_allowed_after_redaction">
) {
  if (policies.includes("local_only")) return "local_only" as const;
  if (policies.includes("cloud_allowed_after_redaction"))
    return "cloud_allowed_after_redaction" as const;
  return "cloud_allowed" as const;
}

function publicRunError(error: unknown): { code: string; message: string } {
  const code = error instanceof Error ? error.message : "AGENT_RUN_FAILED";
  if (code === "AGENT_RUN_CANCELLED" || code === "AGENT_RUN_NOT_RUNNING")
    return { code: "AGENT_RUN_CANCELLED", message: "本轮对话已停止" };
  if (code === "AGENT_SESSION_ACCESS_REVOKED")
    return { code, message: "当前会话的知识范围已失效，未保存本轮助手回答" };
  if (["MODEL_BUDGET_EXCEEDED", "MODEL_PROVIDER_BUDGET_EXCEEDED"].includes(code))
    return {
      code,
      message: "今日模型调用额度已用尽，请明日再试或联系管理员调整额度"
    };
  if ((error as NodeJS.ErrnoException).code === "ENOENT")
    return { code: "WIKI_NOT_READY", message: "绑定知识库尚未完成发布" };
  if (code.startsWith("MODEL_")) return { code, message: "模型暂时不可用，未保存本轮助手回答" };
  return { code: "AGENT_RUN_FAILED", message: "对话暂时不可用，未保存本轮助手回答" };
}

function answerChunks(answer: string): string[] {
  const chunks = answer.match(/[\s\S]{1,160}/g) ?? [];
  return chunks.length ? chunks : ["现有知识库中没有找到足够依据。"];
}

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const securityError = await enforceAuthenticatedMutation(request, user.id, "agent_run.create", {
    limit: 30,
    windowSeconds: 60
  });
  if (securityError) return securityError;
  const parsed = createAgentMessageInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "消息格式不正确", undefined, parsed.error.flatten());
  const { sessionId } = await context.params;
  try {
    const resolved = await resolveAgentSessionContext(sessionId, user.id, {
      resolveWikiPage: async ({ spaceId, pageId }) => {
        const page = await getWikiPage(path.join(dataRoot(), spaceId), pageId);
        return page ? { title: page.title } : null;
      }
    });
    if (!resolved.bindings.length)
      return apiError(
        409,
        "AGENT_CONTEXT_UNAVAILABLE",
        "当前会话没有可用的知识范围",
        "添加已授权知识空间，或恢复被撤销的空间权限后再试"
      );
    if (!(await isManagedSkillEnabled(resolved.session.organizationId, "wiki-query")))
      return apiError(
        409,
        "SKILL_DISABLED",
        "知识问答 Skill 已停用",
        "前往系统设置重新启用 wiki-query"
      );
    const startedAt = Date.now();
    const begun = await beginAgentSessionRun({
      sessionId,
      userId: user.id,
      question: parsed.data.message,
      runId: randomUUID()
    });
    await recordAgentLoopRouting({
      organizationId: resolved.session.organizationId,
      sessionId,
      runId: begun.run.id,
      userId: user.id,
      loop: SERVER_AGENT_LOOP
    });
    const runAbort = registerAgentRunStream(begun.run.id, user.id, startedAt);
    const stopOnDisconnect = () => {
      stopActiveAgentRunStream(begun.run.id, user.id);
      void stopAgentSessionRun({
        runId: begun.run.id,
        userId: user.id,
        durationMs: Date.now() - startedAt
      }).catch(() => undefined);
    };
    request.signal.addEventListener("abort", stopOnDisconnect, { once: true });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: Parameters<typeof sseEvent>[0]) =>
          controller.enqueue(sseEvent(agentRunStreamEventSchema.parse(event)));
        const execute = async () => {
          try {
            emit({ type: "run.started", runId: begun.run.id, userMessage: begun.userMessage });
            if (SERVER_AGENT_LOOP === "pi") {
              // Pi 主路径与应急 internal 路径共用 begin/SSE/settle 持久化契约。
              const piTurn = await runPiKnowledgeTurn({
                runId: begun.run.id,
                component: piSessionComponent(resolved, dataRoot()),
                gateway: await createManagedChatGateway(resolved.session.organizationId, user.id),
                dataPolicy: strictestDataPolicy(
                  resolved.bindings.map(({ dataPolicy }) => dataPolicy)
                ),
                question: parsed.data.message,
                conversation: begun.conversation.map(({ role, content }) => ({
                  role,
                  content
                })),
                policy: piSessionPolicyBridge({
                  assertReadable: () => assertAgentSessionBindingsReadable(sessionId, user.id)
                }),
                signal: runAbort.signal
              });
              if (runAbort.signal.aborted) throw new Error("AGENT_RUN_CANCELLED");
              for (const event of piToolStreamEvents(piTurn.events, begun.run.id, {
                searchedPages: piTurn.result.evidence.searchedPages,
                evidenceCount: piTurn.result.evidence.items.length
              })) {
                await assertAgentSessionBindingsReadable(sessionId, user.id);
                emit(event);
              }
              for (const text of answerChunks(piTurn.result.answer.answer)) {
                if (runAbort.signal.aborted) throw new Error("AGENT_RUN_CANCELLED");
                await assertAgentSessionBindingsReadable(sessionId, user.id);
                emit({ type: "assistant.delta", runId: begun.run.id, text });
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
              }
              const completed = await completeAgentSessionRun({
                runId: begun.run.id,
                sessionId,
                userId: user.id,
                result: groundedQueryResultSchema.parse(piTurn.result),
                durationMs: Date.now() - startedAt,
                toolCalls: knowledgeToolCallRecords(piTurn.events, {
                  searchedPages: piTurn.result.evidence.searchedPages,
                  evidenceCount: piTurn.result.evidence.items.length,
                  bindingCount: resolved.bindings.length
                }).map((record) => ({
                  name: record.name,
                  bindingIds: resolved.bindings.map(({ id }) => id),
                  inputSummary: record.inputSummary,
                  outputSummary: record.outputSummary,
                  resultCount: record.resultCount,
                  searchedPages: record.searchedPages,
                  durationMs: 0
                }))
              });
              emit({
                type: "run.completed",
                runId: begun.run.id,
                result: piTurn.result,
                run: completed.run,
                assistantMessageId: completed.assistantMessageId
              });
              return;
            }
            const result = await runBoundKnowledgeAgent(
              begun.run.id,
              resolved.bindings.map(
                ({ id, spaceId, scope, targetId, courseResourceVersionIds }) => ({
                  bindingId: id,
                  spaceId,
                  spaceRoot: path.join(dataRoot(), spaceId),
                  ...(scope === "wiki_page" && targetId ? { filter: { pageIds: [targetId] } } : {}),
                  ...(scope === "resource_version" && targetId
                    ? { filter: { resourceVersionIds: [targetId] } }
                    : {}),
                  ...(scope === "course" && courseResourceVersionIds?.length
                    ? { filter: { resourceVersionIds: courseResourceVersionIds } }
                    : {})
                })
              ),
              parsed.data.message,
              {
                gateway: await createManagedChatGateway(resolved.session.organizationId, user.id),
                dataPolicy: strictestDataPolicy(
                  resolved.bindings.map(({ dataPolicy }) => dataPolicy)
                ),
                signal: runAbort.signal,
                assertReadable: () => assertAgentSessionBindingsReadable(sessionId, user.id),
                enableToolLoop: true,
                conversation: begun.conversation.map(({ role, content }) => ({ role, content })),
                onKnowledgeToolEvent: async (event) => {
                  await assertAgentSessionBindingsReadable(sessionId, user.id);
                  if (event.phase === "requested") {
                    emit({
                      type: "tool.requested",
                      runId: begun.run.id,
                      tool: event.name,
                      inputSummary:
                        event.name === "knowledge.search"
                          ? `在 ${resolved.bindings.length} 个已绑定知识空间中检索`
                          : "读取已检索的受管证据片段"
                    });
                    return;
                  }
                  emit({
                    type: "tool.completed",
                    runId: begun.run.id,
                    tool: event.name,
                    outputSummary:
                      event.name === "knowledge.search"
                        ? `已检索 ${event.searchedPages ?? 0} 页，得到 ${event.resultCount ?? 0} 条候选`
                        : `已读取 ${event.resultCount ?? 0} 条受管证据片段`
                  });
                }
              }
            );
            if (runAbort.signal.aborted) throw new Error("AGENT_RUN_CANCELLED");
            const toolCallDurationMs = Date.now() - startedAt;
            for (const text of answerChunks(result.result.answer.answer)) {
              if (runAbort.signal.aborted) throw new Error("AGENT_RUN_CANCELLED");
              await assertAgentSessionBindingsReadable(sessionId, user.id);
              emit({ type: "assistant.delta", runId: begun.run.id, text });
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
            if (runAbort.signal.aborted) throw new Error("AGENT_RUN_CANCELLED");
            const completed = await completeAgentSessionRun({
              runId: begun.run.id,
              sessionId,
              userId: user.id,
              result: groundedQueryResultSchema.parse(result.result),
              durationMs: Date.now() - startedAt,
              toolCalls: result.knowledgeToolCalls.map((toolCall) => ({
                name: toolCall.name,
                bindingIds: resolved.bindings.map(({ id }) => id),
                inputSummary:
                  toolCall.name === "knowledge.search"
                    ? `在 ${resolved.bindings.length} 个受管知识范围中检索`
                    : `读取 ${toolCall.resultCount} 个已检索证据片段`,
                outputSummary:
                  toolCall.name === "knowledge.search"
                    ? `检索 ${result.result.evidence.searchedPages} 页，得到 ${result.result.evidence.items.length} 条候选`
                    : `读取 ${toolCall.resultCount} 个受管证据片段`,
                resultCount: toolCall.resultCount,
                searchedPages: toolCall.searchedPages,
                durationMs:
                  toolCall.name === "knowledge.search" ? toolCallDurationMs : toolCall.durationMs
              }))
            });
            emit({
              type: "run.completed",
              runId: begun.run.id,
              result: result.result,
              run: completed.run,
              assistantMessageId: completed.assistantMessageId
            });
          } catch (error) {
            const problem = publicRunError(error);
            if (problem.code === "AGENT_RUN_CANCELLED") {
              await stopAgentSessionRun({
                runId: begun.run.id,
                userId: user.id,
                durationMs: Date.now() - startedAt
              }).catch(() => undefined);
              emit({ type: "run.stopped", runId: begun.run.id });
            } else {
              await settleAgentSessionRun({
                runId: begun.run.id,
                sessionId,
                userId: user.id,
                status: "failed",
                durationMs: Date.now() - startedAt,
                errorCode: problem.code
              }).catch(() => undefined);
              emit({ type: "run.failed", runId: begun.run.id, ...problem });
            }
          } finally {
            request.signal.removeEventListener("abort", stopOnDisconnect);
            clearAgentRunStream(begun.run.id);
            controller.close();
          }
        };
        void execute();
      },
      cancel() {
        stopOnDisconnect();
      }
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "AGENT_RUN_CREATE_FAILED";
    if (code === "AGENT_SESSION_NOT_FOUND") return apiError(404, code, "会话不存在或无权访问");
    if (code === "AGENT_SESSION_ARCHIVED")
      return apiError(409, code, "归档会话不能继续提问", "请先恢复会话");
    if (code === "AGENT_RUN_ACTIVE") return apiError(409, code, "当前会话已有正在运行的对话");
    return apiError(500, "AGENT_RUN_CREATE_FAILED", "无法创建本轮对话，请稍后重试");
  }
}
