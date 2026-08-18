import type { EvidenceBundle } from "@wknowledge/contracts";
import type { RegisteredAgentTool } from "./agent-tool-registry";
import type { KnowledgeComponent } from "./knowledge-component";
import { readToolOutput, searchToolOutput } from "./knowledge-component";

/**
 * knowledge.* Pi tools over the KnowledgeComponent port (M3-13, ADR 0005 §3).
 *
 * `knowledge.search` takes no arguments — the question is fixed per run, exactly
 * like the existing internal tool contract; `knowledge.read` only accepts ids of
 * the current filtered bundle. Tool result payloads reuse the internal loop's
 * exact output shapes (searchToolOutput/readToolOutput) so the Pi path and the
 * internal path stay byte-comparable. `source.open` stays a component/UI
 * operation and is deliberately NOT exposed to the model.
 */

export interface KnowledgeToolRun {
  question: string;
  signal?: AbortSignal;
}

function listScopesTool(component: KnowledgeComponent): RegisteredAgentTool {
  return {
    name: "knowledge.list",
    label: "knowledge.list",
    description: "列出当前会话已授权的知识范围。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    executionMode: "sequential",
    risk: "low",
    requiredScope: "knowledge.list",
    execute: async () => {
      const scopes = await component.listScopes();
      return {
        content: [{ type: "text", text: JSON.stringify({ scopes }) }],
        details: { resultCount: scopes.length }
      };
    }
  };
}

function searchTool(component: KnowledgeComponent, run: KnowledgeToolRun): RegisteredAgentTool {
  return {
    name: "knowledge.search",
    label: "knowledge.search",
    description: "检索当前已授权知识范围。查询固定为当前用户问题。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    executionMode: "sequential",
    risk: "low",
    requiredScope: "knowledge.search",
    execute: async () => {
      const evidence: EvidenceBundle = await component.search({
        question: run.question,
        ...(run.signal !== undefined ? { signal: run.signal } : {})
      });
      return {
        content: [{ type: "text", text: searchToolOutput(evidence) }],
        details: {
          resultCount: evidence.items.length,
          searchedPages: evidence.searchedPages
        }
      };
    }
  };
}

function readTool(component: KnowledgeComponent): RegisteredAgentTool {
  return {
    name: "knowledge.read",
    label: "knowledge.read",
    description: "读取本轮 knowledge.search 返回的证据片段。",
    parameters: {
      type: "object",
      properties: {
        evidenceIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 }
      },
      required: ["evidenceIds"],
      additionalProperties: false
    },
    executionMode: "sequential",
    risk: "low",
    requiredScope: "knowledge.read",
    execute: async (input) => {
      const params = input.params as { evidenceIds: string[] };
      const pages = await component.read({ evidenceIds: params.evidenceIds });
      return {
        content: [
          {
            type: "text",
            text: readToolOutput(
              pages.map(({ pageId, pageTitle, content }) => ({ pageId, pageTitle, content }))
            )
          }
        ],
        details: { resultCount: pages.length }
      };
    }
  };
}

export function createKnowledgeTools(
  component: KnowledgeComponent,
  run: KnowledgeToolRun
): RegisteredAgentTool[] {
  if (typeof run.question !== "string" || run.question.trim().length < 2) {
    throw new Error("KNOWLEDGE_SEARCH_QUESTION_INVALID");
  }
  return [listScopesTool(component), searchTool(component, run), readTool(component)];
}
