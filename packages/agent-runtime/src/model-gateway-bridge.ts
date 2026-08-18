import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Message,
  type Tool
} from "@earendil-works/pi-ai";
import type { DataPolicy } from "@wknowledge/contracts";
import type { ModelGateway, ModelResponse, ModelToolCallOutput } from "@wknowledge/model-gateway";

const GATEWAY_API = "wknowledge-gateway";
const GATEWAY_PROVIDER = "wknowledge";

export interface GatewayStreamFnOptions {
  dataPolicy: DataPolicy;
  purpose: Extract<
    Parameters<ModelGateway["invoke"]>[0]["purpose"],
    "wiki_query" | "agent" | "learning"
  >;
  signal?: AbortSignal;
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function gatewayAssistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  model: string,
  errorMessage?: string
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: GATEWAY_API,
    provider: GATEWAY_PROVIDER,
    model,
    usage: emptyUsage(),
    stopReason,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    timestamp: 0
  };
}

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(({ text }) => text)
    .join("");
}

/**
 * Converts a Pi request context into the gateway chat payload. Only the message
 * shapes Wknowledge itself produces are accepted; anything else fails closed
 * instead of being silently coerced.
 */
export function contextToGatewayPayload(
  context: Context,
  tools: readonly Tool[]
): { messages: unknown[]; tools?: unknown[] } {
  const messages: unknown[] = [];
  if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: textOf(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = message.content.filter(
        (block): block is { type: "toolCall"; id: string; name: string; arguments: object } =>
          block.type === "toolCall"
      );
      if (toolCalls.length) {
        messages.push({
          role: "assistant",
          tool_calls: toolCalls.map(({ id, name, arguments: args }) => ({
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) }
          }))
        });
        continue;
      }
      messages.push({ role: "assistant", content: textOf(message.content) });
      continue;
    }
    if (message.role === "toolResult") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: textOf(message.content)
      });
      continue;
    }
    throw new Error("PI_CONTEXT_UNSUPPORTED");
  }
  const toolDefinitions = tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
  return {
    messages,
    ...(toolDefinitions.length ? { tools: toolDefinitions } : {})
  };
}

function isModelToolCallOutput(value: unknown): value is ModelToolCallOutput {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "tool_calls" &&
    Array.isArray((value as { toolCalls?: unknown }).toolCalls)
  );
}

function stableErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : undefined;
  return message && /^[A-Z][A-Z0-9_]*$/.test(message) ? message : "MODEL_GATEWAY_FAILED";
}

/**
 * StreamFn bridge: the Model Gateway stays the only provider route. Model,
 * credentials, budget, fallback and audit decisions remain on the Wknowledge
 * side; the bridge only adapts request/response shapes for Pi.
 */
export function createGatewayStreamFn(
  gateway: ModelGateway,
  options: GatewayStreamFnOptions
): StreamFn {
  return (model, context, callOptions) => {
    const stream = createAssistantMessageEventStream();
    void (model as unknown);
    // The per-call signal Pi passes on every LLM round reflects the current
    // run; the construction-time signal (if any) is combined in so a caller
    // holding the original signal can still stop a reused bridge.
    const signal = combineSignals(callOptions?.signal, options.signal);
    const invoke = async () =>
      gateway.invoke({
        capability: "chat",
        dataPolicy: options.dataPolicy,
        purpose: options.purpose,
        payload: contextToGatewayPayload(context, context.tools ?? []),
        ...(signal ? { signal } : {})
      });
    void invoke()
      .then((response: ModelResponse) => {
        if (typeof response.output === "string") {
          const message = gatewayAssistant(
            response.output ? [{ type: "text", text: response.output }] : [],
            "stop",
            response.model
          );
          stream.push({ type: "start", partial: message });
          if (response.output) {
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
            stream.push({
              type: "text_delta",
              contentIndex: 0,
              delta: response.output,
              partial: message
            });
            stream.push({
              type: "text_end",
              contentIndex: 0,
              content: response.output,
              partial: message
            });
          }
          stream.push({ type: "done", reason: "stop", message });
          return;
        }
        if (isModelToolCallOutput(response.output)) {
          const content = response.output.toolCalls.map((call) => ({
            type: "toolCall" as const,
            id: call.id,
            name: call.name,
            arguments: JSON.parse(call.arguments) as object
          }));
          const message = gatewayAssistant(content, "toolUse", response.model);
          stream.push({ type: "start", partial: message });
          content.forEach((toolCall, contentIndex) => {
            stream.push({ type: "toolcall_start", contentIndex, partial: message });
            stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
          });
          stream.push({ type: "done", reason: "toolUse", message });
          return;
        }
        stream.push({
          type: "error",
          reason: "error",
          error: gatewayAssistant([], "error", response.model, "MODEL_OUTPUT_INVALID")
        });
      })
      .catch((error: unknown) => {
        if (signal?.aborted) {
          // An aborted gateway call is a user stop, not a model failure: the
          // aborted reason folds to stopReason "aborted" and then to
          // run.stopped, never to run.failed with a provider error code.
          stream.push({
            type: "error",
            reason: "aborted",
            error: gatewayAssistant([], "aborted", GATEWAY_PROVIDER)
          });
          return;
        }
        stream.push({
          type: "error",
          reason: "error",
          error: gatewayAssistant([], "error", GATEWAY_PROVIDER, stableErrorCode(error))
        });
      });
    return stream;
  };
}

function combineSignals(
  callSignal: AbortSignal | undefined,
  ownSignal: AbortSignal | undefined
): AbortSignal | undefined {
  if (callSignal && ownSignal) return AbortSignal.any([callSignal, ownSignal]);
  return callSignal ?? ownSignal;
}
