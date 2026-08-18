import type {
  AgentLoopConfig,
  AgentTool,
  BeforeToolCallResult,
  AfterToolCallResult
} from "@earendil-works/pi-agent-core";

/**
 * Component Tool Registry and Policy Bridge (M5-15, ADR 0004/0005 §3).
 *
 * Domain components register narrow tools (schema + risk + required scope +
 * handler). The registry is the only source of tools handed to Pi: nothing
 * unregistered exists, and no Pi/Coding-Agent default tool is ever injected.
 * The Wknowledge policy bridge (permissions, approval, budget, trimming,
 * audit) is a pi-free contract; `policyHooks` adapts it onto the Pi loop
 * hooks. Every policy denial fails closed with a stable code, and a crashing
 * policy subsystem blocks the call and terminates the run instead of letting
 * an unchecked result through.
 */

export type AgentToolRisk = "low" | "medium" | "high";

export interface AgentToolTextContent {
  type: "text";
  text: string;
}

export interface AgentToolDescriptor {
  name: string;
  label?: string;
  description: string;
  parameters: { type: "object" } & Record<string, unknown>;
  executionMode?: "sequential" | "parallel";
  risk: AgentToolRisk;
  requiredScope: string;
}

export interface AgentToolHandlerInput {
  toolCallId: string;
  params: unknown;
  signal?: AbortSignal;
}

export interface AgentToolHandlerResult {
  content: AgentToolTextContent[];
  details?: unknown;
}

export interface RegisteredAgentTool extends AgentToolDescriptor {
  execute(input: AgentToolHandlerInput): Promise<AgentToolHandlerResult>;
}

export type AgentToolPolicyDecision =
  { allow: true } | { allow: false; code: string; terminate?: boolean };

export interface AgentToolAfterCallOverride {
  content?: AgentToolTextContent[];
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

export interface AgentToolPolicyBridge {
  beforeToolCall(input: {
    tool: AgentToolDescriptor;
    args: unknown;
  }): Promise<AgentToolPolicyDecision>;
  afterToolCall(input: {
    tool: AgentToolDescriptor;
    args: unknown;
    result: { content: readonly AgentToolTextContent[]; details?: unknown; isError: boolean };
  }): Promise<AgentToolAfterCallOverride>;
}

export interface AgentToolRegistry {
  register(tool: RegisteredAgentTool): void;
  get(name: string): RegisteredAgentTool | undefined;
  list(): readonly RegisteredAgentTool[];
  toPiTools(): AgentTool[];
  policyHooks(bridge: AgentToolPolicyBridge): {
    beforeToolCall: NonNullable<AgentLoopConfig["beforeToolCall"]>;
    afterToolCall: NonNullable<AgentLoopConfig["afterToolCall"]>;
  };
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9.-]{0,99}$/;
const TOOL_DESCRIPTION_LIMIT = 2_000;
const TOOL_SCOPE_LIMIT = 200;

function toolError(code: string): never {
  throw new Error(code);
}

function assertDescriptorShape(tool: RegisteredAgentTool): void {
  if (!TOOL_NAME_PATTERN.test(tool.name)) toolError("AGENT_TOOL_DEFINITION_INVALID");
  if (tool.description.trim().length === 0 || tool.description.length > TOOL_DESCRIPTION_LIMIT) {
    toolError("AGENT_TOOL_DEFINITION_INVALID");
  }
  if (
    typeof tool.parameters !== "object" ||
    tool.parameters === null ||
    tool.parameters.type !== "object"
  ) {
    toolError("AGENT_TOOL_DEFINITION_INVALID");
  }
  if (tool.risk !== "low" && tool.risk !== "medium" && tool.risk !== "high") {
    toolError("AGENT_TOOL_DEFINITION_INVALID");
  }
  if (tool.requiredScope.trim().length === 0 || tool.requiredScope.length > TOOL_SCOPE_LIMIT) {
    toolError("AGENT_TOOL_DEFINITION_INVALID");
  }
  if (typeof tool.execute !== "function") toolError("AGENT_TOOL_DEFINITION_INVALID");
}

export function createAgentToolRegistry(): AgentToolRegistry {
  const tools = new Map<string, RegisteredAgentTool>();
  return {
    register(tool) {
      assertDescriptorShape(tool);
      if (tools.has(tool.name)) toolError("AGENT_TOOL_DUPLICATE");
      tools.set(tool.name, tool);
    },
    get(name) {
      return tools.get(name);
    },
    list() {
      return [...tools.values()];
    },
    toPiTools() {
      return [...tools.values()].map((tool) => ({
        name: tool.name,
        label: tool.label ?? tool.name,
        description: tool.description,
        parameters: tool.parameters,
        executionMode: tool.executionMode ?? "sequential",
        execute: (toolCallId: string, params: unknown, signal?: AbortSignal) =>
          tool.execute({
            toolCallId,
            params,
            ...(signal !== undefined ? { signal } : {})
          })
      })) as AgentTool[];
    },
    policyHooks(bridge) {
      return {
        async beforeToolCall(context): Promise<BeforeToolCallResult | undefined> {
          const tool = tools.get(context.toolCall.name);
          if (!tool) return { block: true, reason: "AGENT_TOOL_UNKNOWN" };
          let decision;
          try {
            decision = await bridge.beforeToolCall({ tool, args: context.args });
          } catch {
            return {
              block: true,
              reason: "AGENT_TOOL_POLICY_FAILED",
              terminate: true
            };
          }
          if (decision.allow) return undefined;
          return {
            block: true,
            reason: decision.code,
            ...(decision.terminate !== undefined ? { terminate: decision.terminate } : {})
          };
        },
        async afterToolCall(context): Promise<AfterToolCallResult | undefined> {
          const tool = tools.get(context.toolCall.name);
          if (!tool) {
            return {
              content: [{ type: "text", text: "AGENT_TOOL_UNKNOWN" }],
              isError: true,
              terminate: true
            };
          }
          const textContent = context.result.content.filter(
            (block): block is { type: "text"; text: string } => block.type === "text"
          );
          let override;
          try {
            override = await bridge.afterToolCall({
              tool,
              args: context.args,
              result: {
                content: textContent,
                details: context.result.details,
                isError: context.isError
              }
            });
          } catch {
            return {
              content: [{ type: "text", text: "AGENT_TOOL_POLICY_FAILED" }],
              isError: true,
              terminate: true
            };
          }
          const merged: AfterToolCallResult = {};
          if (override.content !== undefined) {
            merged.content = override.content as NonNullable<AfterToolCallResult["content"]>;
          }
          if (override.details !== undefined) merged.details = override.details;
          if (override.isError !== undefined) merged.isError = override.isError;
          if (override.terminate !== undefined) merged.terminate = override.terminate;
          return merged;
        }
      };
    }
  };
}
