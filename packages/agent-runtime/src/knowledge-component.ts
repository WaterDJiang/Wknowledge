import {
  groundedAnswerSchema,
  groundedQueryResultSchema,
  type EvidenceBundle,
  type GroundedQueryResult
} from "@wknowledge/contracts";
import { queryWikiEvidence } from "@wknowledge/wiki";

/**
 * LLM Wiki component port (M3-13, upgrade spec §4.1).
 *
 * The Markdown wiki, CompiledNode, SourceLocator and publishing protocol stay
 * inside the wiki package — this port only exposes narrow, authorized,
 * pre-filtered results to callers (and, through the tool registry, to Pi).
 * Scopes are fixed when the component is constructed from validated session
 * bindings; search takes only the question, read only returns excerpts of the
 * current filtered EvidenceBundle, and openSource only opens sources that
 * belong to evidence the caller already received. No host paths, tables or
 * connections cross this boundary.
 */

export type KnowledgeScopeKind = "space" | "wiki-page" | "resource-version" | "course";

export interface KnowledgeScopeFilter {
  pageIds?: readonly string[];
  resourceVersionIds?: readonly string[];
}

export interface KnowledgeScopeRef {
  bindingId: string;
  kind: KnowledgeScopeKind;
  spaceId: string;
  label: string;
  filter?: KnowledgeScopeFilter;
}

export interface KnowledgeScopeSummary {
  bindingId: string;
  kind: KnowledgeScopeKind;
  spaceId: string;
  label: string;
}

export interface KnowledgeExcerptPage {
  evidenceId: string;
  pageId: string;
  pageTitle: string;
  content: string;
  sourceRefs: readonly string[];
}

export interface AuthorizedSourcePreview {
  bindingId: string;
  spaceId: string;
  evidenceId: string;
  sourceIndex: number;
  sourceRef: string;
}

export interface KnowledgeToolPage {
  pageId: string;
  pageTitle: string;
  content: string;
}

/**
 * Canonical tool-result payload shapes shared by the internal loop and the
 * Pi tools so both paths stay byte-comparable.
 */
export function searchToolOutput(evidence: EvidenceBundle): string {
  return JSON.stringify({
    evidence: evidence.items.map(({ id, pageId, pageTitle, pageType, sourceRefs }) => ({
      id,
      pageId,
      pageTitle,
      pageType,
      sourceRefs
    }))
  });
}

export function readToolOutput(readPages: readonly KnowledgeToolPage[]): string {
  return JSON.stringify({ readPages });
}

/**
 * Honest degradation when the model output cannot be trusted as a grounded
 * answer (shared by the internal loop and the Pi path).
 */
export function extractiveFallback(evidence: EvidenceBundle): GroundedQueryResult {
  if (evidence.items.length === 0)
    return groundedQueryResultSchema.parse({
      answer: {
        answer: "现有知识库中没有找到足够依据。",
        evidenceIds: [],
        insufficientEvidence: true,
        mode: "extractive_fallback"
      },
      evidence
    });

  const conflictNotice = evidence.items.some((item) => item.conflicted)
    ? "注意：检索到的资料包含尚未裁决的并列结论，以下内容不代表唯一事实。\n\n"
    : "";
  return groundedQueryResultSchema.parse({
    answer: {
      answer: `${conflictNotice}${evidence.items.map(({ text }) => text).join("\n\n")}`,
      evidenceIds: evidence.items.map(({ id }) => id),
      insufficientEvidence: false,
      mode: "extractive_fallback"
    },
    evidence
  });
}

/**
 * Final answer contract for the Pi knowledge path: a model output only
 * becomes the answer when it is valid JSON, a generated-mode GroundedAnswer,
 * and cites only evidence from the current bundle. Anything else degrades to
 * the extractive fallback instead of surfacing an ungrounded answer.
 */
export function finalizeGroundedAnswer(
  modelOutput: string | null,
  evidence: EvidenceBundle
): GroundedQueryResult {
  if (typeof modelOutput !== "string") return extractiveFallback(evidence);
  try {
    const raw: unknown = JSON.parse(modelOutput);
    const answer = groundedAnswerSchema.parse(raw);
    if (answer.mode !== "generated") return extractiveFallback(evidence);
    return groundedQueryResultSchema.parse({ answer, evidence });
  } catch {
    return extractiveFallback(evidence);
  }
}

export interface KnowledgeComponent {
  listScopes(): Promise<readonly KnowledgeScopeSummary[]>;
  search(input: { question: string; signal?: AbortSignal }): Promise<EvidenceBundle>;
  read(input: { evidenceIds: readonly string[] }): Promise<readonly KnowledgeExcerptPage[]>;
  openSource(input: { evidenceId: string; sourceIndex: number }): Promise<AuthorizedSourcePreview>;
}

export interface BoundKnowledgeSearchContext {
  bindingId: string;
  spaceId: string;
  spaceRoot: string;
  filter?: { pageIds?: readonly string[]; resourceVersionIds?: readonly string[] };
}

export interface BoundKnowledgeSearchOutcome {
  evidence: EvidenceBundle;
  perBinding: ReadonlyArray<{
    bindingId: string;
    spaceId: string;
    evidence: EvidenceBundle;
  }>;
}

/**
 * Shared bound search used by both the existing knowledge agent and the
 * KnowledgeComponent port: search every bound space, merge results under
 * `spaceId__evidenceId` identity, deduplicate, cap at the bundle limit.
 * Extracted verbatim from runBoundKnowledgeAgent — its regression suite is
 * the equivalence baseline.
 */
export async function searchBoundKnowledge(input: {
  contexts: readonly BoundKnowledgeSearchContext[];
  question: string;
  assertReadable?: () => Promise<void>;
}): Promise<BoundKnowledgeSearchOutcome> {
  const assert = async () => {
    await input.assertReadable?.();
  };
  await assert();
  if (input.contexts.length === 0 || input.contexts.length > 8) {
    throw new Error("AGENT_CONTEXT_INVALID");
  }
  const uniqueBindingIds = new Set(input.contexts.map(({ bindingId }) => bindingId));
  if (uniqueBindingIds.size !== input.contexts.length) throw new Error("AGENT_CONTEXT_INVALID");

  const searched = await Promise.all(
    input.contexts.map(async ({ bindingId, spaceId, spaceRoot, filter }) => {
      await assert();
      const evidence = await queryWikiEvidence(spaceRoot, input.question, 10, filter);
      await assert();
      return { bindingId, spaceId, spaceRoot, evidence };
    })
  );
  await assert();
  const evidenceItems = searched
    .flatMap(({ bindingId, spaceId, evidence }) =>
      evidence.items.map((item) => ({
        ...item,
        id: `${spaceId}__${item.id}`,
        bindingId
      }))
    )
    .reduce<Array<(typeof searched)[number]["evidence"]["items"][number]>>((items, item) => {
      const duplicate = items.some((candidate) => candidate.id === item.id);
      if (!duplicate) items.push(item);
      return items;
    }, [])
    .slice(0, 10);
  const evidence = groundedQueryResultSchema.shape.evidence.parse({
    question: input.question,
    items: evidenceItems,
    searchedPages: searched.reduce((total, { evidence }) => total + evidence.searchedPages, 0),
    embeddingCalls: 0
  });
  return {
    evidence,
    perBinding: searched.map(({ bindingId, spaceId, evidence: bound }) => ({
      bindingId,
      spaceId,
      evidence: bound
    }))
  };
}

export interface BoundKnowledgeComponentDeps {
  scopes: readonly KnowledgeScopeRef[];
  resolveSpaceRoot: (scope: KnowledgeScopeRef) => Promise<string>;
  openSource: (input: {
    scope: KnowledgeScopeRef;
    evidenceId: string;
    sourceIndex: number;
    sourceRef: string;
  }) => Promise<AuthorizedSourcePreview>;
  assertReadable?: () => Promise<void>;
}

const MAX_READ_EVIDENCE_IDS = 10;

function knowledgeError(code: string): never {
  throw new Error(code);
}

export function createBoundKnowledgeComponent(
  deps: BoundKnowledgeComponentDeps
): KnowledgeComponent {
  if (deps.scopes.length === 0 || deps.scopes.length > 8) {
    knowledgeError("AGENT_CONTEXT_INVALID");
  }
  const bindingIds = new Set(deps.scopes.map(({ bindingId }) => bindingId));
  if (bindingIds.size !== deps.scopes.length) knowledgeError("AGENT_CONTEXT_INVALID");
  for (const scope of deps.scopes) {
    if (!scope.bindingId.trim() || !scope.spaceId.trim() || !scope.label.trim()) {
      knowledgeError("AGENT_CONTEXT_INVALID");
    }
  }

  let currentEvidence: EvidenceBundle | null = null;
  return {
    async listScopes() {
      return deps.scopes.map(({ bindingId, kind, spaceId, label }) => ({
        bindingId,
        kind,
        spaceId,
        label
      }));
    },

    async search(input) {
      if (input.signal?.aborted) knowledgeError("AGENT_RUN_CANCELLED");
      if (typeof input.question !== "string" || input.question.trim().length < 2) {
        knowledgeError("KNOWLEDGE_SEARCH_QUESTION_INVALID");
      }
      const contexts = await Promise.all(
        deps.scopes.map(async (scope) => ({
          bindingId: scope.bindingId,
          spaceId: scope.spaceId,
          spaceRoot: await deps.resolveSpaceRoot(scope),
          ...(scope.filter !== undefined ? { filter: scope.filter } : {})
        }))
      );
      const outcome = await searchBoundKnowledge({
        contexts,
        question: input.question,
        ...(deps.assertReadable !== undefined
          ? { assertReadable: () => deps.assertReadable!() }
          : {})
      });
      currentEvidence = outcome.evidence;
      return outcome.evidence;
    },

    async read(input) {
      if (currentEvidence === null) knowledgeError("KNOWLEDGE_READ_BEFORE_SEARCH");
      if (
        !Array.isArray(input.evidenceIds) ||
        input.evidenceIds.length === 0 ||
        input.evidenceIds.length > MAX_READ_EVIDENCE_IDS ||
        input.evidenceIds.some((id) => typeof id !== "string" || id.length === 0)
      ) {
        knowledgeError("KNOWLEDGE_READ_INPUT_INVALID");
      }
      const wanted = new Set(input.evidenceIds);
      return currentEvidence.items
        .filter(({ id }) => wanted.has(id))
        .map(({ id, pageId, pageTitle, text, sourceRefs }) => ({
          evidenceId: id,
          pageId,
          pageTitle,
          content: text,
          sourceRefs
        }));
    },

    async openSource(input) {
      if (currentEvidence === null) knowledgeError("KNOWLEDGE_READ_BEFORE_SEARCH");
      const item = currentEvidence.items.find(({ id }) => id === input.evidenceId);
      if (!item) knowledgeError("KNOWLEDGE_SOURCE_NOT_IN_BUNDLE");
      if (
        !Number.isInteger(input.sourceIndex) ||
        input.sourceIndex < 0 ||
        input.sourceIndex >= item.sourceRefs.length
      ) {
        knowledgeError("KNOWLEDGE_SOURCE_INDEX_INVALID");
      }
      const sourceRef = item.sourceRefs[input.sourceIndex] as string;
      const [spaceId] = input.evidenceId.split("__");
      const scope = deps.scopes.find((candidate) => candidate.spaceId === spaceId);
      if (!scope) knowledgeError("KNOWLEDGE_SOURCE_SCOPE_INVALID");
      return deps.openSource({
        scope,
        evidenceId: input.evidenceId,
        sourceIndex: input.sourceIndex,
        sourceRef
      });
    }
  };
}

export interface KnowledgeConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export const MAX_AGENT_CONVERSATION_MESSAGES = 12;
export const MAX_AGENT_CONVERSATION_CHARACTERS = 6_000;
export const MAX_AGENT_CONVERSATION_MESSAGE_CHARACTERS = 1_200;

/**
 * Bounded chronological context: keeps the most recent turns within the
 * character budgets. History is untrusted context for intent only — it is
 * never evidence or a permission source.
 */
export function compactAgentConversation(
  messages: readonly KnowledgeConversationMessage[]
): KnowledgeConversationMessage[] {
  const selected: KnowledgeConversationMessage[] = [];
  let remaining = MAX_AGENT_CONVERSATION_CHARACTERS;
  for (const message of [...messages].reverse()) {
    if (selected.length >= MAX_AGENT_CONVERSATION_MESSAGES || remaining <= 0) break;
    if (
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string"
    )
      continue;
    const content = message.content.trim().slice(0, MAX_AGENT_CONVERSATION_MESSAGE_CHARACTERS);
    if (!content) continue;
    if (content.length > remaining) continue;
    selected.push({ role: message.role, content });
    remaining -= content.length;
  }
  return selected.reverse();
}
