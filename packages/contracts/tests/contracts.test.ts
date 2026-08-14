import { describe, expect, it } from "vitest";
import {
  compiledDocumentSchema,
  createAgentContextBindingInputSchema,
  createAgentSessionInputSchema,
  createModelProviderInputSchema,
  groundedQueryResultSchema,
  normalizeLegacyCompiledDocument,
  parserManifestSchema,
  parserOutputSchema,
  materializePlanComposeCandidateInputSchema,
  materializePracticeGenerateCandidateInputSchema,
  practiceGenerateCandidateOutputSchema,
  processingJobSchema,
  queryRunAuditSchema,
  sourceLocatorSchema,
  wikiGoldenDatasetSchema,
  updateModelProviderInputSchema,
  wikiCompileProfileSchema,
  wikiPageListQuerySchema,
  wikiPageFrontmatterSchema,
  wikiReviewInputSchema
} from "../src/index";

describe("source contracts", () => {
  it("requires traceable structured practice-generate candidates without leaking answer keys into inputs", () => {
    const courseId = "11111111-1111-4111-8111-111111111111";
    const unitId = "22222222-2222-4222-8222-222222222222";
    const pointId = "33333333-3333-4333-8333-333333333333";
    const versionId = "44444444-4444-4444-8444-444444444444";
    const candidateId = "55555555-5555-4555-8555-555555555555";
    const sourceRef = `wk://source/${versionId}/eyJ0eXBlIjoiZG9jdW1lbnQiLCJyZXNvdXJjZVZlcnNpb25JZCI6IjQ0NDQ0NDQ0LTQ0NDQtNDQ0NC04NDQ0LTQ0NDQ0NDQ0NDQ0NCIsIm5vZGVJZCI6InByYWN0aWNlIn0`;
    expect(
      practiceGenerateCandidateOutputSchema.parse({
        courseId,
        difficulty: "easy",
        questions: [
          {
            courseUnitId: unitId,
            knowledgePointId: pointId,
            resourceVersionId: versionId,
            sourceRef,
            answerType: "exact_response",
            prompt: "请写出固定原文中的关键学习重点。",
            answerKey: "受管答案键",
            rubric: {
              kind: "exact_response",
              normalization: "nfkc_trim_casefold_whitespace",
              maximumScore: 1,
              note: "按固定答案键确定性判定。"
            }
          }
        ]
      })
    ).toMatchObject({ courseId, questions: [{ courseUnitId: unitId }] });
    expect(() =>
      practiceGenerateCandidateOutputSchema.parse({
        courseId,
        difficulty: "standard",
        questions: [
          {
            courseUnitId: unitId,
            knowledgePointId: pointId,
            resourceVersionId: versionId,
            sourceRef,
            answerType: "exact_response",
            prompt: "缺少答案键",
            rubric: {
              kind: "exact_response",
              normalization: "nfkc_trim_casefold_whitespace",
              maximumScore: 1,
              note: "不完整"
            }
          }
        ]
      })
    ).toThrow();
    expect(materializePracticeGenerateCandidateInputSchema.parse({ candidateId })).toEqual({
      candidateId
    });
  });

  it("requires structured, bounded plan-compose candidate materialization input", () => {
    const versionId = "22222222-2222-4222-8222-222222222222";
    const candidateId = "33333333-3333-4333-8333-333333333333";
    expect(
      materializePlanComposeCandidateInputSchema.parse({
        candidateId,
        goal: "学习固定资料",
        selectedResourceVersionIds: [versionId]
      })
    ).toMatchObject({ candidateId, selectedResourceVersionIds: [versionId] });
    expect(() =>
      materializePlanComposeCandidateInputSchema.parse({
        candidateId,
        goal: "学习固定资料",
        selectedResourceVersionIds: []
      })
    ).toThrow();
  });

  it("only accepts structured managed agent context targets", () => {
    const spaceId = "11111111-1111-4111-8111-111111111111";
    const versionId = "22222222-2222-4222-8222-222222222222";
    expect(createAgentContextBindingInputSchema.parse({ spaceId, scope: "space" })).toEqual({
      spaceId,
      scope: "space"
    });
    expect(
      createAgentContextBindingInputSchema.parse({
        spaceId,
        scope: "wiki_page",
        targetId: "topic-memory"
      })
    ).toMatchObject({ scope: "wiki_page", targetId: "topic-memory" });
    expect(
      createAgentContextBindingInputSchema.parse({
        spaceId,
        scope: "resource_version",
        targetId: versionId
      })
    ).toMatchObject({ scope: "resource_version", targetId: versionId });
    expect(() =>
      createAgentContextBindingInputSchema.parse({
        spaceId,
        scope: "wiki_page",
        targetId: "../raw/secrets"
      })
    ).toThrow();
    expect(() =>
      createAgentContextBindingInputSchema.parse({
        spaceId,
        scope: "space",
        targetId: versionId,
        virtualPath: "/knowledge/forged"
      })
    ).toThrow();
  });

  it("requires one to eight unique explicit bindings when creating a session", () => {
    const spaceId = "11111111-1111-4111-8111-111111111111";
    const binding = { spaceId, scope: "wiki_page" as const, targetId: "topic-memory" };
    expect(
      createAgentSessionInputSchema.parse({ title: "指定页面对话", bindings: [binding] })
    ).toMatchObject({ bindings: [binding] });
    expect(() =>
      createAgentSessionInputSchema.parse({ title: "没有范围", bindings: [] })
    ).toThrow();
    expect(() =>
      createAgentSessionInputSchema.parse({ title: "重复范围", bindings: [binding, binding] })
    ).toThrow("AGENT_CONTEXT_BINDING_DUPLICATE");
    expect(() =>
      createAgentSessionInputSchema.parse({
        title: "伪造路径",
        bindings: [{ ...binding, virtualPath: "/knowledge/forged" }]
      })
    ).toThrow();
  });

  it("separates answerable and refusal expectations in wiki golden datasets", () => {
    const base = {
      schemaVersion: 1,
      id: "pilot-v0.1",
      stage: "pilot",
      description: "受控试点",
      thresholds: { recallAt10: 0.8, citationAccuracy: 0.8, refusalAccuracy: 0.8 },
      documents: [
        {
          id: "memory",
          spaceId: "11111111-1111-4111-8111-111111111111",
          resourceVersionId: "22222222-2222-4222-8222-222222222222",
          resourceName: "学习科学.md",
          profile: "knowledge",
          nodes: [
            {
              schemaVersion: 1,
              id: "memory",
              kind: "paragraph",
              content: "间隔检索有助于长期记忆。",
              order: 0,
              locator: {
                type: "document",
                resourceVersionId: "22222222-2222-4222-8222-222222222222",
                nodeId: "memory"
              },
              metadata: {}
            }
          ]
        }
      ]
    };
    expect(
      wikiGoldenDatasetSchema.parse({
        ...base,
        questions: [
          {
            id: "q-memory",
            question: "怎样改善长期记忆？",
            language: "zh-CN",
            questionType: "fact",
            expectRefusal: false,
            expectedPageIds: ["topic-22222222-2222-4222-8222-222222222222-memory"],
            expectedResourceVersionIds: ["22222222-2222-4222-8222-222222222222"],
            expectedSourceRefs: [
              "wk://source/22222222-2222-4222-8222-222222222222/eyJ0eXBlIjoiZG9jdW1lbnQiLCJyZXNvdXJjZVZlcnNpb25JZCI6IjIyMjIyMjIyLTIyMjItNDIyMi04MjIyLTIyMjIyMjIyMjIyMiIsIm5vZGVJZCI6Im1lbW9yeSJ9"
            ]
          }
        ]
      }).questions
    ).toHaveLength(1);
    expect(() =>
      wikiGoldenDatasetSchema.parse({
        ...base,
        questions: [
          {
            id: "q-refuse",
            question: "量子态如何演化？",
            language: "zh-CN",
            questionType: "unanswerable",
            expectRefusal: true,
            expectedPageIds: ["should-not-exist"],
            expectedResourceVersionIds: []
          }
        ]
      })
    ).toThrow("REFUSAL_EXPECTATION_CANNOT_CARRY_TARGETS");
  });

  it("keeps query run audit records metadata-only and embedding-free", () => {
    const audit = queryRunAuditSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      questionSha256: "a".repeat(64),
      questionLength: 8,
      answerMode: "extractive_fallback",
      insufficientEvidence: false,
      searchedPages: 3,
      embeddingCalls: 0,
      durationMs: 12,
      candidates: [
        {
          evidenceId: "evidence-01",
          pageId: "topic-memory",
          pageTitle: "检索练习",
          pageType: "topic",
          rank: 1,
          sourceCount: 1,
          cited: true
        }
      ],
      modelCall: null
    });
    expect(JSON.stringify(audit)).not.toContain("怎样改善长期记忆");
    expect(() => queryRunAuditSchema.parse({ ...audit, embeddingCalls: 1 })).toThrow();
  });

  it("validates model settings without accepting an empty replacement secret", () => {
    expect(
      createModelProviderInputSchema.parse({
        name: "本地 Ollama",
        location: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen3"
      })
    ).toMatchObject({ enabled: true, timeoutMs: 20_000 });
    expect(
      createModelProviderInputSchema.parse({
        name: "本地转写",
        capabilities: ["speech_to_text"],
        location: "local",
        baseUrl: "http://127.0.0.1:9000/v1",
        model: "whisper"
      }).capabilities
    ).toEqual(["speech_to_text"]);
    expect(
      createModelProviderInputSchema.parse({
        name: "本地视觉",
        capabilities: ["chat", "vision"],
        location: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen-vl"
      }).capabilities
    ).toEqual(["chat", "vision"]);
    expect(() =>
      createModelProviderInputSchema.parse({
        name: "非法能力",
        capabilities: ["embedding"],
        location: "local",
        baseUrl: "http://127.0.0.1:9000/v1",
        model: "embedding"
      })
    ).toThrow("MODEL_PROVIDER_CAPABILITIES_INVALID");
    expect(() =>
      createModelProviderInputSchema.parse({
        name: "云模型",
        location: "cloud",
        baseUrl: "https://example.com/v1",
        model: "chat"
      })
    ).toThrow("CLOUD_PROVIDER_API_KEY_REQUIRED");
    expect(() => updateModelProviderInputSchema.parse({ apiKey: "" })).toThrow();
  });
  it("requires grounded answers to cite only evidence in the current bundle", () => {
    const base = {
      answer: {
        answer: "间隔检索有助于长期记忆。",
        evidenceIds: ["evidence-01"],
        insufficientEvidence: false,
        mode: "extractive_fallback"
      },
      evidence: {
        question: "怎样改善长期记忆？",
        items: [
          {
            id: "evidence-01",
            pageId: "topic-memory",
            pageTitle: "检索练习",
            pageType: "topic",
            text: "间隔检索有助于长期记忆。",
            sourceRefs: [
              "wk://source/11111111-1111-4111-8111-111111111111/eyJ0eXBlIjoicGRmIiwicmVzb3VyY2VWZXJzaW9uSWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJwYWdlIjozfQ"
            ]
          }
        ],
        searchedPages: 1,
        embeddingCalls: 0
      }
    };
    expect(groundedQueryResultSchema.parse(base).answer.evidenceIds).toEqual(["evidence-01"]);
    expect(() =>
      groundedQueryResultSchema.parse({
        ...base,
        answer: { ...base.answer, evidenceIds: ["evidence-missing"] }
      })
    ).toThrow();
    expect(() =>
      groundedQueryResultSchema.parse({
        ...base,
        answer: { ...base.answer, insufficientEvidence: true }
      })
    ).toThrow();
  });

  it("accepts the three explicit wiki compile profiles", () => {
    expect(wikiCompileProfileSchema.parse("knowledge")).toBe("knowledge");
    expect(wikiCompileProfileSchema.parse("case")).toBe("case");
    expect(wikiCompileProfileSchema.parse("reference")).toBe("reference");
    expect(() => wikiCompileProfileSchema.parse("auto")).toThrow();
    expect(
      wikiPageListQuerySchema.parse({ types: ["topic", "case"], search: "学习" })
    ).toMatchObject({ types: ["topic", "case"] });
  });

  it("accepts a versioned PDF locator", () => {
    expect(
      sourceLocatorSchema.parse({
        type: "pdf",
        resourceVersionId: "11111111-1111-4111-8111-111111111111",
        page: 3
      })
    ).toMatchObject({ type: "pdf", page: 3 });
  });

  it("requires wiki pages to carry a managed source", () => {
    expect(() =>
      wikiPageFrontmatterSchema.parse({
        schemaVersion: 1,
        id: "topic-test",
        title: "Test",
        type: "topic",
        status: "draft",
        aliases: [],
        tags: [],
        sourceRefs: [],
        related: [],
        sourceMarking: "extracted",
        humanVerified: false,
        lastCompiled: new Date().toISOString()
      })
    ).toThrow();
  });

  it("requires reviewer metadata for human-reviewed wiki pages", () => {
    const page = {
      schemaVersion: 1 as const,
      id: "topic-reviewed",
      title: "Reviewed",
      type: "topic" as const,
      status: "reviewed" as const,
      aliases: [],
      tags: [],
      sourceRefs: ["wk://source/11111111-1111-4111-8111-111111111111/example"],
      related: [],
      sourceMarking: "extracted" as const,
      humanVerified: true,
      lastCompiled: new Date().toISOString()
    };
    expect(() => wikiPageFrontmatterSchema.parse(page)).toThrow("WIKI_REVIEW_METADATA_REQUIRED");
    expect(
      wikiPageFrontmatterSchema.parse({
        ...page,
        reviewedAt: "2026-08-13T02:00:00.000Z",
        reviewedBy: "22222222-2222-4222-8222-222222222222"
      })
    ).toMatchObject({ status: "reviewed", humanVerified: true });
    expect(wikiReviewInputSchema.parse({ action: "approve" })).toEqual({ action: "approve" });
  });

  it("validates live processing progress and failure details", () => {
    const base = {
      id: "11111111-1111-4111-8111-111111111111",
      spaceId: "22222222-2222-4222-8222-222222222222",
      resourceVersionId: "33333333-3333-4333-8333-333333333333",
      kind: "resource.process",
      stage: "wiki_compile",
      errorCode: null,
      errorMessage: null,
      updatedAt: "2026-08-12T09:00:00.000Z"
    };

    expect(
      processingJobSchema.parse({ ...base, status: "processing", progress: 60 })
    ).toMatchObject({ status: "processing", stage: "wiki_compile", progress: 60 });
    expect(() =>
      processingJobSchema.parse({ ...base, status: "processing", progress: 101 })
    ).toThrow();
  });

  it("validates ordered compiled nodes and parser provenance", () => {
    const resourceVersionId = "33333333-3333-4333-8333-333333333333";
    const document = compiledDocumentSchema.parse({
      schemaVersion: 1,
      resourceVersionId,
      nodes: [
        {
          schemaVersion: 1,
          id: "heading-1",
          kind: "heading",
          title: "学习方法",
          content: "学习方法",
          order: 0,
          locator: { type: "document", resourceVersionId, nodeId: "heading-1" },
          metadata: { level: 1 }
        },
        {
          schemaVersion: 1,
          id: "paragraph-1",
          kind: "paragraph",
          content: "间隔检索有助于长期记忆。",
          parentId: "heading-1",
          order: 1,
          locator: { type: "document", resourceVersionId, nodeId: "paragraph-1" },
          metadata: {}
        }
      ]
    });
    expect(document.nodes[1]?.parentId).toBe("heading-1");
    expect(
      parserManifestSchema.parse({
        schemaVersion: 1,
        parserId: "wknowledge-node-text",
        parserVersion: "1.0.0",
        runtime: "node",
        mimeType: "text/markdown",
        resourceVersionId,
        generatedAt: "2026-08-12T10:00:00.000Z"
      })
    ).toMatchObject({ parserId: "wknowledge-node-text", runtime: "node" });
  });

  it("rejects duplicate, orphaned and cross-version compiled nodes", () => {
    const resourceVersionId = "33333333-3333-4333-8333-333333333333";
    const base = {
      schemaVersion: 1,
      kind: "paragraph",
      content: "正文",
      metadata: {},
      locator: { type: "document", resourceVersionId, nodeId: "paragraph-1" }
    };
    expect(() =>
      compiledDocumentSchema.parse({
        schemaVersion: 1,
        resourceVersionId,
        nodes: [
          { ...base, id: "paragraph-1", order: 0 },
          { ...base, id: "paragraph-1", order: 0, parentId: "missing" }
        ]
      })
    ).toThrow();
    expect(() =>
      compiledDocumentSchema.parse({
        schemaVersion: 1,
        resourceVersionId,
        nodes: [
          {
            ...base,
            id: "paragraph-1",
            order: 0,
            locator: {
              type: "document",
              resourceVersionId: "44444444-4444-4444-8444-444444444444",
              nodeId: "paragraph-1"
            }
          }
        ]
      })
    ).toThrow();
    expect(() =>
      parserOutputSchema.parse({
        document: {
          schemaVersion: 1,
          resourceVersionId,
          nodes: [{ ...base, id: "paragraph-1", order: 0 }]
        },
        manifest: {
          schemaVersion: 1,
          parserId: "wknowledge-node-text",
          parserVersion: "1.0.0",
          runtime: "node",
          mimeType: "text/plain",
          resourceVersionId: "44444444-4444-4444-8444-444444444444",
          generatedAt: "2026-08-12T10:00:00.000Z"
        }
      })
    ).toThrow();
  });

  it("normalizes prototype nodes into the formal v1 contract", () => {
    const resourceVersionId = "33333333-3333-4333-8333-333333333333";
    const normalized = normalizeLegacyCompiledDocument(
      {
        schemaVersion: 1,
        nodes: [
          {
            id: "document-root",
            title: "旧资料",
            content: "旧格式正文",
            locator: { type: "document", resourceVersionId, nodeId: "document-root" },
            tags: ["兼容"]
          }
        ]
      },
      resourceVersionId
    );
    expect(normalized.nodes[0]).toMatchObject({
      schemaVersion: 1,
      id: "document-root",
      kind: "paragraph",
      order: 0,
      metadata: { legacyTags: ["兼容"] }
    });
    expect(() => compiledDocumentSchema.parse(normalized)).not.toThrow();
  });
});
