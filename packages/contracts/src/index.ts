import { z } from "zod";

export const roleSchema = z.enum(["owner", "admin", "editor", "learner", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

export const dataPolicySchema = z.enum([
  "local_only",
  "cloud_allowed",
  "cloud_allowed_after_redaction"
]);
export type DataPolicy = z.infer<typeof dataPolicySchema>;

const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const locatorBase = { resourceVersionId: z.string().uuid() };

export const sourceLocatorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pdf"),
    ...locatorBase,
    page: z.number().int().positive(),
    bbox: bboxSchema.optional()
  }),
  z.object({
    type: z.literal("video"),
    ...locatorBase,
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive()
  }),
  z.object({
    type: z.literal("audio"),
    ...locatorBase,
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive()
  }),
  z.object({
    type: z.literal("sheet"),
    ...locatorBase,
    sheet: z.string().min(1),
    range: z.string().min(1)
  }),
  z.object({
    type: z.literal("slide"),
    ...locatorBase,
    slide: z.number().int().positive(),
    shapeId: z.string().optional()
  }),
  z.object({ type: z.literal("document"), ...locatorBase, nodeId: z.string().min(1) }),
  z.object({ type: z.literal("image"), ...locatorBase, bbox: bboxSchema.optional() })
]);
export type SourceLocator = z.infer<typeof sourceLocatorSchema>;

export const sheetPreviewSchema = z.object({
  locator: z.object({
    type: z.literal("sheet"),
    resourceVersionId: z.string().uuid(),
    sheet: z.string().min(1),
    range: z.string().min(1)
  }),
  content: z.string().min(1),
  metadata: z.object({
    rowStart: z.number().int().positive(),
    rowEnd: z.number().int().positive(),
    columnCount: z.number().int().positive(),
    formulaSummaryTruncated: z.boolean(),
    formulas: z.array(
      z.object({ cell: z.string().min(1), formula: z.string().min(2).startsWith("=") })
    )
  })
});
export type SheetPreview = z.infer<typeof sheetPreviewSchema>;

export const slidePreviewItemSchema = z.object({
  shapeId: z.string().min(1).nullable(),
  role: z.enum(["shape", "notes"]),
  content: z.string().min(1),
  textTruncated: z.boolean()
});

export const slidePreviewSchema = z.object({
  locator: z.object({
    type: z.literal("slide"),
    resourceVersionId: z.string().uuid(),
    slide: z.number().int().positive(),
    shapeId: z.string().min(1).optional()
  }),
  items: z.array(slidePreviewItemSchema).min(1)
});
export type SlidePreview = z.infer<typeof slidePreviewSchema>;

export const imagePreviewSchema = z.object({
  locator: z.object({
    type: z.literal("image"),
    resourceVersionId: z.string().uuid(),
    bbox: bboxSchema
  }),
  content: z.string().min(1),
  metadata: z.object({
    imageWidth: z.number().int().positive(),
    imageHeight: z.number().int().positive(),
    textTruncated: z.boolean()
  })
});
export type ImagePreview = z.infer<typeof imagePreviewSchema>;

const compiledNodeIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/);

export const compiledNodeKindSchema = z.enum([
  "heading",
  "paragraph",
  "table",
  "image",
  "slide",
  "transcript"
]);

export const compiledNodeSchema = z.object({
  schemaVersion: z.literal(1),
  id: compiledNodeIdSchema,
  kind: compiledNodeKindSchema,
  title: z.string().min(1).optional(),
  content: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, "COMPILED_NODE_EMPTY"),
  parentId: compiledNodeIdSchema.optional(),
  order: z.number().int().nonnegative(),
  locator: sourceLocatorSchema,
  metadata: z.record(z.string(), z.unknown())
});
export type CompiledNode = z.infer<typeof compiledNodeSchema>;

export const compiledDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    resourceVersionId: z.string().uuid(),
    nodes: z.array(compiledNodeSchema).min(1)
  })
  .superRefine((document, context) => {
    const indexes = new Map<string, number>();
    const orders = new Map<number, number>();
    for (const [index, node] of document.nodes.entries()) {
      const duplicateId = indexes.get(node.id);
      if (duplicateId !== undefined) {
        context.addIssue({
          code: "custom",
          message: `COMPILED_NODE_ID_DUPLICATE:${duplicateId}`,
          path: ["nodes", index, "id"]
        });
      } else {
        indexes.set(node.id, index);
      }
      const duplicateOrder = orders.get(node.order);
      if (duplicateOrder !== undefined) {
        context.addIssue({
          code: "custom",
          message: `COMPILED_NODE_ORDER_DUPLICATE:${duplicateOrder}`,
          path: ["nodes", index, "order"]
        });
      } else {
        orders.set(node.order, index);
      }
      if (node.locator.resourceVersionId !== document.resourceVersionId) {
        context.addIssue({
          code: "custom",
          message: "COMPILED_NODE_SOURCE_VERSION_MISMATCH",
          path: ["nodes", index, "locator", "resourceVersionId"]
        });
      }
    }
    for (const [index, node] of document.nodes.entries()) {
      if (!node.parentId) continue;
      const parentIndex = indexes.get(node.parentId);
      if (parentIndex === undefined) {
        context.addIssue({
          code: "custom",
          message: "COMPILED_NODE_PARENT_NOT_FOUND",
          path: ["nodes", index, "parentId"]
        });
        continue;
      }
      if (parentIndex === index) {
        context.addIssue({
          code: "custom",
          message: "COMPILED_NODE_PARENT_SELF_REFERENCE",
          path: ["nodes", index, "parentId"]
        });
      } else if (document.nodes[parentIndex]!.order >= node.order) {
        context.addIssue({
          code: "custom",
          message: "COMPILED_NODE_PARENT_ORDER_INVALID",
          path: ["nodes", index, "parentId"]
        });
      }
    }
  });
export type CompiledDocument = z.infer<typeof compiledDocumentSchema>;

export const parserManifestSchema = z.object({
  schemaVersion: z.literal(1),
  parserId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  parserVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  runtime: z.enum(["node", "python"]),
  mimeType: z.string().min(3),
  resourceVersionId: z.string().uuid(),
  generatedAt: z.string().datetime({ offset: true })
});
export type ParserManifest = z.infer<typeof parserManifestSchema>;

export const compiledAssetSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(240)
    .regex(/^[a-z0-9][a-z0-9._/-]*$/),
  contentType: z.string().min(3).max(120),
  byteSize: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024)
});
export type CompiledAsset = z.infer<typeof compiledAssetSchema>;

export const pdfPageManifestSchema = z.object({
  schemaVersion: z.literal(1),
  pages: z
    .array(
      z.object({
        page: z.number().int().positive(),
        path: z.string().regex(/^pdf-pages\/page-\d{3}\.png$/),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        pdfPointWidth: z.number().positive(),
        pdfPointHeight: z.number().positive()
      })
    )
    .min(1)
    .max(200)
});
export type PdfPageManifest = z.infer<typeof pdfPageManifestSchema>;

export const pdfRegionPreviewSchema = z.object({
  locator: z.object({
    type: z.literal("pdf"),
    resourceVersionId: z.string().uuid(),
    page: z.number().int().positive(),
    bbox: bboxSchema
  }),
  page: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    pdfPointWidth: z.number().positive(),
    pdfPointHeight: z.number().positive()
  }),
  content: z.string().min(1),
  textTruncated: z.boolean()
});
export type PdfRegionPreview = z.infer<typeof pdfRegionPreviewSchema>;

export const parserOutputSchema = z
  .object({
    document: compiledDocumentSchema,
    manifest: parserManifestSchema
  })
  .superRefine((output, context) => {
    if (output.manifest.resourceVersionId !== output.document.resourceVersionId) {
      context.addIssue({
        code: "custom",
        message: "PARSER_MANIFEST_SOURCE_VERSION_MISMATCH",
        path: ["manifest", "resourceVersionId"]
      });
    }
  });
export type ParserOutput = z.infer<typeof parserOutputSchema>;

const legacyCompiledDocumentSchema = z.object({
  schemaVersion: z.literal(1).optional(),
  nodes: z
    .array(
      z.object({
        id: compiledNodeIdSchema,
        title: z.string().min(1),
        content: z.string().min(1),
        locator: sourceLocatorSchema,
        tags: z.array(z.string()).optional()
      })
    )
    .min(1)
});

export function normalizeLegacyCompiledDocument(
  input: unknown,
  resourceVersionId: string
): CompiledDocument {
  const legacy = legacyCompiledDocumentSchema.parse(input);
  return compiledDocumentSchema.parse({
    schemaVersion: 1,
    resourceVersionId,
    nodes: legacy.nodes.map((node, order) => ({
      schemaVersion: 1,
      id: node.id,
      kind: "paragraph",
      title: node.title,
      content: node.content,
      order,
      locator: node.locator,
      metadata: node.tags ? { legacyTags: node.tags } : {}
    }))
  });
}

export const sourceMarkingSchema = z.enum(["extracted", "synthesized", "ai_completed"]);
export const wikiCompileProfileSchema = z.enum(["knowledge", "case", "reference"]);
export type WikiCompileProfile = z.infer<typeof wikiCompileProfileSchema>;

export const wikiPageFrontmatterSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    title: z.string().min(1),
    type: z.enum(["concept", "topic", "case", "course", "material"]),
    status: z.enum(["draft", "reviewed", "conflicted", "deprecated"]),
    aliases: z.array(z.string()),
    tags: z.array(z.string()),
    sourceRefs: z.array(z.string().startsWith("wk://")).min(1),
    related: z.array(z.string()),
    sourceMarking: sourceMarkingSchema,
    compileProfile: wikiCompileProfileSchema.optional(),
    conflictIds: z.array(z.string().regex(/^conflict-[a-f0-9]{24}$/)).optional(),
    humanVerified: z.boolean(),
    reviewedAt: z.string().datetime({ offset: true }).optional(),
    reviewedBy: z.string().uuid().optional(),
    lastCompiled: z.string().datetime({ offset: true })
  })
  .superRefine((page, context) => {
    const reviewed = page.status === "reviewed" && page.humanVerified;
    if (reviewed && (!page.reviewedAt || !page.reviewedBy)) {
      context.addIssue({
        code: "custom",
        message: "WIKI_REVIEW_METADATA_REQUIRED",
        path: ["reviewedAt"]
      });
    }
    if (!reviewed && (page.reviewedAt || page.reviewedBy)) {
      context.addIssue({
        code: "custom",
        message: "WIKI_REVIEW_METADATA_UNEXPECTED",
        path: ["reviewedAt"]
      });
    }
  });
export type WikiPageFrontmatter = z.infer<typeof wikiPageFrontmatterSchema>;

export const wikiReviewInputSchema = z.object({
  action: z.enum(["approve", "reopen"])
});
export type WikiReviewInput = z.infer<typeof wikiReviewInputSchema>;

export const wikiConflictStatusSchema = z.enum(["open", "parallel", "resolved"]);
export type WikiConflictStatus = z.infer<typeof wikiConflictStatusSchema>;

export const createWikiConflictInputSchema = z
  .object({
    leftPageId: wikiPageFrontmatterSchema.shape.id,
    rightPageId: wikiPageFrontmatterSchema.shape.id
  })
  .refine((input) => input.leftPageId !== input.rightPageId, {
    message: "WIKI_CONFLICT_PAGES_MUST_DIFFER",
    path: ["rightPageId"]
  });
export type CreateWikiConflictInput = z.infer<typeof createWikiConflictInputSchema>;

export const wikiConflictDecisionInputSchema = z.object({
  action: z.enum(["select_left", "select_right", "keep_parallel"])
});
export type WikiConflictDecisionInput = z.infer<typeof wikiConflictDecisionInputSchema>;

export const wikiConflictSummarySchema = z.object({
  id: z.string().regex(/^conflict-[a-f0-9]{24}$/),
  status: wikiConflictStatusSchema,
  leftPageId: wikiPageFrontmatterSchema.shape.id,
  rightPageId: wikiPageFrontmatterSchema.shape.id,
  createdAt: z.string().datetime({ offset: true }),
  createdBy: z.string().uuid(),
  resolvedAt: z.string().datetime({ offset: true }).optional(),
  resolvedBy: z.string().uuid().optional(),
  resolution: z.enum(["select_left", "select_right", "keep_parallel"]).optional()
});
export type WikiConflictSummary = z.infer<typeof wikiConflictSummarySchema>;

export const wikiProposalStatusSchema = z.enum(["pending", "accepted", "rejected", "stale"]);
export type WikiProposalStatus = z.infer<typeof wikiProposalStatusSchema>;

export const wikiProposalDecisionInputSchema = z.object({
  action: z.enum(["accept", "reject"])
});
export type WikiProposalDecisionInput = z.infer<typeof wikiProposalDecisionInputSchema>;

const wikiDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const wikiPageChangeProposalSummarySchema = z.object({
  id: z.string().regex(/^proposal-[a-f0-9]{24}$/),
  pageId: wikiPageFrontmatterSchema.shape.id,
  status: wikiProposalStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  resolvedAt: z.string().datetime({ offset: true }).optional(),
  resolvedBy: z.string().uuid().optional(),
  baseDigest: wikiDigestSchema,
  candidateDigest: wikiDigestSchema,
  changedLineCount: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative()
});
export type WikiPageChangeProposalSummary = z.infer<typeof wikiPageChangeProposalSummarySchema>;

export const wikiPageRevisionSummarySchema = z.object({
  id: z.string().regex(/^revision-[a-f0-9]{24}$/),
  pageId: wikiPageFrontmatterSchema.shape.id,
  action: z.enum(["approved", "proposal_accepted"]),
  createdAt: z.string().datetime({ offset: true }),
  actorUserId: z.string().uuid(),
  digest: wikiDigestSchema
});
export type WikiPageRevisionSummary = z.infer<typeof wikiPageRevisionSummarySchema>;

export const wikiPageDiffLineSchema = z.object({
  type: z.enum(["unchanged", "added", "removed"]),
  text: z.string(),
  baseLine: z.number().int().positive().optional(),
  candidateLine: z.number().int().positive().optional()
});
export type WikiPageDiffLine = z.infer<typeof wikiPageDiffLineSchema>;

export const wikiPageChangeProposalDetailSchema = wikiPageChangeProposalSummarySchema.extend({
  base: z.object({ digest: wikiDigestSchema, content: z.string() }),
  candidate: z.object({ digest: wikiDigestSchema, content: z.string() }),
  diff: z.array(wikiPageDiffLineSchema)
});
export type WikiPageChangeProposalDetail = z.infer<typeof wikiPageChangeProposalDetailSchema>;

export const wikiPageListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: wikiPageFrontmatterSchema.shape.status.optional(),
  type: wikiPageFrontmatterSchema.shape.type.optional(),
  types: z.array(wikiPageFrontmatterSchema.shape.type).min(1).max(5).optional()
});
export type WikiPageListQuery = z.infer<typeof wikiPageListQuerySchema>;

export interface WikiPageSummary {
  id: string;
  title: string;
  type: WikiPageFrontmatter["type"];
  status: WikiPageFrontmatter["status"];
  aliases: string[];
  tags: string[];
  sourceMarking: WikiPageFrontmatter["sourceMarking"];
  humanVerified: boolean;
  conflictIds: string[];
  reviewedAt?: string;
  reviewedBy?: string;
  lastCompiled: string;
  sourceCount: number;
  excerpt: string;
}

export interface WikiPageDetail extends WikiPageSummary {
  content: string;
  sourceRefs: string[];
  related: string[];
}

export interface WikiConflictDetail extends WikiConflictSummary {
  left: WikiPageDetail;
  right: WikiPageDetail;
}

const evidenceIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__)?evidence-\d{2,3}$/);
export const evidenceItemSchema = z.object({
  id: evidenceIdSchema,
  pageId: wikiPageFrontmatterSchema.shape.id,
  pageTitle: z.string().min(1),
  pageType: wikiPageFrontmatterSchema.shape.type,
  text: z.string().min(1).max(2_000),
  sourceRefs: z.array(z.string().startsWith("wk://")).min(1),
  conflicted: z.boolean().default(false)
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const evidenceBundleSchema = z
  .object({
    question: z.string().min(2).max(4_000),
    items: z.array(evidenceItemSchema).max(10),
    searchedPages: z.number().int().nonnegative(),
    embeddingCalls: z.literal(0)
  })
  .superRefine((bundle, context) => {
    const ids = new Set<string>();
    for (const [index, item] of bundle.items.entries()) {
      if (ids.has(item.id))
        context.addIssue({
          code: "custom",
          message: "EVIDENCE_ID_DUPLICATE",
          path: ["items", index, "id"]
        });
      ids.add(item.id);
    }
  });
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

export const groundedAnswerSchema = z.object({
  answer: z.string().min(1),
  evidenceIds: z.array(evidenceIdSchema),
  insufficientEvidence: z.boolean(),
  mode: z.enum(["generated", "extractive_fallback"])
});
export type GroundedAnswer = z.infer<typeof groundedAnswerSchema>;

export const groundedQueryResultSchema = z
  .object({
    answer: groundedAnswerSchema,
    evidence: evidenceBundleSchema
  })
  .superRefine((result, context) => {
    const available = new Set(result.evidence.items.map(({ id }) => id));
    for (const [index, id] of result.answer.evidenceIds.entries()) {
      if (!available.has(id))
        context.addIssue({
          code: "custom",
          message: "GROUNDED_ANSWER_EVIDENCE_UNKNOWN",
          path: ["answer", "evidenceIds", index]
        });
    }
    if (result.answer.insufficientEvidence && result.answer.evidenceIds.length > 0)
      context.addIssue({
        code: "custom",
        message: "INSUFFICIENT_ANSWER_CANNOT_CITE_EVIDENCE",
        path: ["answer", "evidenceIds"]
      });
    if (!result.answer.insufficientEvidence && result.answer.evidenceIds.length === 0)
      context.addIssue({
        code: "custom",
        message: "GROUNDED_ANSWER_EVIDENCE_REQUIRED",
        path: ["answer", "evidenceIds"]
      });
  });
export type GroundedQueryResult = z.infer<typeof groundedQueryResultSchema>;

export const modelCapabilitySchema = z.enum([
  "chat",
  "vision",
  "embedding",
  "rerank",
  "speech_to_text",
  "text_to_speech",
  "image_generation",
  "video_understanding",
  "video_generation"
]);
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

const jsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof jsonSchemaSchema>;

export const skillManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  version: z.string().min(1),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  description: z.string().min(1),
  inputSchema: jsonSchemaSchema,
  outputSchema: jsonSchemaSchema,
  requiredCapabilities: z.array(modelCapabilitySchema),
  permissions: z.object({
    resources: z.enum(["none", "selected", "space"]),
    filesystem: z.enum(["none", "read", "write-artifacts"]),
    network: z.union([z.literal("deny"), z.array(z.string().url())]),
    approval: z.enum(["never", "conditional", "always"])
  }),
  limits: z.object({
    timeoutSeconds: z.number().int().positive().max(86_400),
    memoryMb: z.number().int().positive().max(65_536),
    maxModelCalls: z.number().int().nonnegative().max(1_000)
  }),
  entrypoint: z.string().min(1)
});
export type SkillManifest = z.infer<typeof skillManifestSchema>;

export const modelProviderLocationSchema = z.enum(["local", "cloud"]);
export type ModelProviderLocation = z.infer<typeof modelProviderLocationSchema>;

export const modelProviderHealthSchema = z.enum(["unknown", "healthy", "unhealthy"]);
export type ModelProviderHealth = z.infer<typeof modelProviderHealthSchema>;

export const modelProviderCapabilitiesSchema = z
  .array(modelCapabilitySchema)
  .min(1)
  .max(3)
  .refine(
    (capabilities) =>
      capabilities.every(
        (capability) =>
          capability === "chat" || capability === "vision" || capability === "speech_to_text"
      ) && new Set(capabilities).size === capabilities.length,
    "MODEL_PROVIDER_CAPABILITIES_INVALID"
  );

const httpUrlSchema = z
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol));

export const managedModelProviderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  kind: z.literal("openai_compatible"),
  capabilities: modelProviderCapabilitiesSchema,
  location: modelProviderLocationSchema,
  baseUrl: httpUrlSchema,
  model: z.string().min(1).max(200),
  enabled: z.boolean(),
  hasApiKey: z.boolean(),
  timeoutMs: z.number().int().min(1_000).max(120_000),
  health: modelProviderHealthSchema,
  lastCheckedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime()
});
export type ManagedModelProvider = z.infer<typeof managedModelProviderSchema>;

export const createModelProviderInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    capabilities: modelProviderCapabilitiesSchema.default(["chat"]),
    location: modelProviderLocationSchema,
    baseUrl: httpUrlSchema,
    model: z.string().trim().min(1).max(200),
    apiKey: z.string().max(10_000).optional(),
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(20_000)
  })
  .superRefine((input, context) => {
    if (input.location === "cloud" && !input.apiKey)
      context.addIssue({
        code: "custom",
        message: "CLOUD_PROVIDER_API_KEY_REQUIRED",
        path: ["apiKey"]
      });
  });
export type CreateModelProviderInput = z.infer<typeof createModelProviderInputSchema>;

export const updateModelProviderInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  capabilities: modelProviderCapabilitiesSchema.optional(),
  location: modelProviderLocationSchema.optional(),
  baseUrl: httpUrlSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  apiKey: z.string().min(1).max(10_000).optional(),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional()
});
export type UpdateModelProviderInput = z.infer<typeof updateModelProviderInputSchema>;

export const managedSkillSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  digest: z.string().startsWith("sha256:"),
  description: z.string(),
  enabled: z.boolean(),
  requiredCapabilities: z.array(modelCapabilitySchema),
  permissions: skillManifestSchema.shape.permissions,
  limits: skillManifestSchema.shape.limits,
  origin: z.enum(["builtin", "installed"]).optional()
});
export type ManagedSkill = z.infer<typeof managedSkillSchema>;

export const updateSkillInputSchema = z.object({ enabled: z.boolean() });

export const skillPolicyDecisionSchema = z.enum(["allow", "ask", "deny"]);
export type SkillPolicyDecision = z.infer<typeof skillPolicyDecisionSchema>;

export const sessionSkillExecutionSchema = z.enum(["conversation", "worker", "unavailable"]);
export type SessionSkillExecution = z.infer<typeof sessionSkillExecutionSchema>;

export const sessionSkillSchema = managedSkillSchema.extend({
  decision: skillPolicyDecisionSchema,
  reason: z.string().min(1).max(200),
  execution: sessionSkillExecutionSchema
});
export type SessionSkill = z.infer<typeof sessionSkillSchema>;

export const createSkillApprovalInputSchema = z.object({
  skillId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  bindingIds: z.array(z.string().uuid()).max(8),
  inputSummary: z.string().trim().min(1).max(500)
});
export type CreateSkillApprovalInput = z.infer<typeof createSkillApprovalInputSchema>;

export const skillApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export type SkillApprovalStatus = z.infer<typeof skillApprovalStatusSchema>;

export const skillApprovalSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  skillId: z.string().min(1),
  skillVersion: z.string().min(1),
  skillDigest: z.string().startsWith("sha256:"),
  bindingIds: z.array(z.string().uuid()).max(8),
  inputSummary: z.string().min(1).max(500),
  status: skillApprovalStatusSchema,
  expiresAt: z.string().datetime(),
  decidedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime()
});
export type SkillApproval = z.infer<typeof skillApprovalSchema>;

export const decideSkillApprovalInputSchema = z.object({ decision: z.enum(["approve", "reject"]) });
export type DecideSkillApprovalInput = z.infer<typeof decideSkillApprovalInputSchema>;

export const skillRunStatusSchema = z.enum(["queued", "running", "completed", "failed", "stopped"]);
export type SkillRunStatus = z.infer<typeof skillRunStatusSchema>;

export const createSkillRunInputSchema = z.object({
  skillId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  bindingIds: z.array(z.string().uuid()).max(8),
  inputSummary: z.string().trim().min(1).max(500)
});
export type CreateSkillRunInput = z.infer<typeof createSkillRunInputSchema>;

export const skillRunSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  skillId: z.string().min(1),
  skillVersion: z.string().min(1),
  skillDigest: z.string().startsWith("sha256:"),
  bindingIds: z.array(z.string().uuid()).max(8),
  approvalId: z.string().uuid().nullable(),
  inputSummary: z.string().min(1).max(500),
  status: skillRunStatusSchema,
  errorCode: z.string().min(1).nullable(),
  outputSummary: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).nullable(),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable()
});
export type SkillRun = z.infer<typeof skillRunSchema>;

export const learningContentOptionSchema = z.object({
  spaceId: z.string().uuid(),
  spaceName: z.string().min(1),
  resourceId: z.string().uuid(),
  resourceVersionId: z.string().uuid(),
  resourceName: z.string().min(1),
  originalName: z.string().min(1),
  version: z.number().int().positive(),
  mimeType: z.string().min(1),
  compileProfile: wikiCompileProfileSchema,
  createdAt: z.string().datetime()
});
export type LearningContentOption = z.infer<typeof learningContentOptionSchema>;

export const learningPlanSelectionSchema = z.object({
  spaceId: z.string().uuid(),
  resourceId: z.string().uuid(),
  resourceVersionId: z.string().uuid(),
  resourceName: z.string().min(1),
  originalName: z.string().min(1),
  version: z.number().int().positive(),
  mimeType: z.string().min(1),
  compileProfile: wikiCompileProfileSchema,
  sourceRef: z.string().startsWith("wk://source/")
});
export type LearningPlanSelection = z.infer<typeof learningPlanSelectionSchema>;

export const learningPlanUnitSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  resourceVersionId: z.string().uuid(),
  sourceRef: z.string().startsWith("wk://source/"),
  objective: z.string().min(1),
  completionRule: z.string().min(1)
});
export type LearningPlanUnit = z.infer<typeof learningPlanUnitSchema>;

export const planComposeCandidateUnitSchema = z.object({
  title: z.string().trim().min(1).max(160),
  resourceVersionId: z.string().uuid(),
  sourceRef: z.string().startsWith("wk://source/"),
  objective: z.string().trim().min(1).max(1_000),
  completionRule: z.string().trim().min(1).max(1_000)
});
export type PlanComposeCandidateUnit = z.infer<typeof planComposeCandidateUnitSchema>;

export const planComposeCandidateOutputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  units: z.array(planComposeCandidateUnitSchema).min(1).max(20)
});
export type PlanComposeCandidateOutput = z.infer<typeof planComposeCandidateOutputSchema>;

export const requestPlanComposeGenerationInputSchema = z.object({
  goal: z.string().trim().min(1).max(500),
  resourceVersionIds: z.array(z.string().uuid()).min(1).max(8)
});
export type RequestPlanComposeGenerationInput = z.infer<
  typeof requestPlanComposeGenerationInputSchema
>;

export const requestPracticeGenerateInputSchema = z.object({
  courseUnitIds: z.array(z.string().uuid()).min(1).max(8),
  difficulty: z.enum(["easy", "standard", "challenge"])
});
export type RequestPracticeGenerateInput = z.infer<typeof requestPracticeGenerateInputSchema>;

export const learningGenerationRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("plan_compose"),
    input: requestPlanComposeGenerationInputSchema
  }),
  z.object({
    kind: z.literal("practice_generate"),
    input: requestPracticeGenerateInputSchema
  })
]);
export type LearningGenerationRequest = z.infer<typeof learningGenerationRequestSchema>;

export const planComposeProvenanceSchema = z.object({
  skillRunId: z.string().uuid(),
  skillId: z.literal("plan-compose"),
  skillVersion: z.string().min(1),
  skillDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/)
});
export type PlanComposeProvenance = z.infer<typeof planComposeProvenanceSchema>;

export const learnerDeclaredSchema = z.object({
  currentLevel: z
    .enum(["beginner", "intermediate", "advanced", "unspecified"])
    .default("unspecified"),
  weeklyMinutes: z.number().int().min(30).max(1_680).default(120),
  preferredPace: z.enum(["steady", "intensive", "flexible"]).default("steady"),
  note: z.string().trim().max(500).default("")
});
export type LearnerDeclared = z.infer<typeof learnerDeclaredSchema>;

const learningPlanSnapshotBaseSchema = z.object({
  schemaVersion: z.literal(1),
  goal: z.string().min(1).max(500),
  learnerDeclared: learnerDeclaredSchema.default({
    currentLevel: "unspecified",
    weeklyMinutes: 120,
    preferredPace: "steady",
    note: ""
  }),
  selections: z.array(learningPlanSelectionSchema).min(1).max(20),
  units: z.array(learningPlanUnitSchema).min(1).max(20)
});
export const learningPlanSnapshotSchema = z.discriminatedUnion("generation", [
  learningPlanSnapshotBaseSchema.extend({ generation: z.literal("deterministic_template") }),
  learningPlanSnapshotBaseSchema.extend({
    generation: z.literal("skill_candidate"),
    provenance: planComposeProvenanceSchema
  })
]);
export type LearningPlanSnapshot = z.infer<typeof learningPlanSnapshotSchema>;

export const createLearningPlanInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(500),
  resourceVersionIds: z.array(z.string().uuid()).min(1).max(20)
});
export type CreateLearningPlanInput = z.infer<typeof createLearningPlanInputSchema>;

export const materializePlanComposeCandidateInputSchema = z.object({
  candidateId: z.string().uuid(),
  goal: z.string().trim().min(1).max(500),
  selectedResourceVersionIds: z.array(z.string().uuid()).min(1).max(20)
});
export type MaterializePlanComposeCandidateInput = z.infer<
  typeof materializePlanComposeCandidateInputSchema
>;

export const planComposeCandidateSchema = z.object({
  id: z.string().uuid(),
  skillRunId: z.string().uuid(),
  title: z.string().min(1),
  resourceVersionIds: z.array(z.string().uuid()).min(1).max(20),
  units: z.array(planComposeCandidateUnitSchema).min(1).max(20),
  materializedLearningPlanId: z.string().uuid().nullable(),
  createdAt: z.string().datetime()
});
export type PlanComposeCandidate = z.infer<typeof planComposeCandidateSchema>;

export const learningPlanSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  status: z.enum(["draft", "active", "completed", "archived"]),
  title: z.string().min(1),
  plan: learningPlanSnapshotSchema,
  confirmedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime()
});
export type LearningPlan = z.infer<typeof learningPlanSchema>;

export const learnerProfileSchema = z.object({
  id: z.string().uuid(),
  declared: learnerDeclaredSchema,
  observed: z.record(z.string(), z.unknown()),
  inferred: z.record(z.string(), z.unknown()),
  updatedAt: z.string().datetime()
});
export type LearnerProfile = z.infer<typeof learnerProfileSchema>;

export const updateLearnerDeclaredInputSchema = learnerDeclaredSchema;
export type UpdateLearnerDeclaredInput = z.infer<typeof updateLearnerDeclaredInputSchema>;

export const learningEventInputSchema = z.object({
  unitId: z.string().min(1).max(120),
  verb: z.enum(["opened", "progressed", "completed"]),
  sourceRef: z.string().startsWith("wk://source/"),
  position: z
    .object({
      page: z.number().int().positive().optional(),
      progressPercent: z.number().min(0).max(100).optional(),
      positionMs: z.number().int().nonnegative().optional()
    })
    .strict()
    .optional()
});
export type LearningEventInput = z.infer<typeof learningEventInputSchema>;

export const learningUnitProgressSchema = learningPlanUnitSchema.extend({
  events: z.number().int().nonnegative(),
  openedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  lastPosition: learningEventInputSchema.shape.position.nullable()
});
export type LearningUnitProgress = z.infer<typeof learningUnitProgressSchema>;

export const courseKnowledgePointSchema = z.object({
  id: z.string().uuid(),
  ordinal: z.number().int().positive(),
  title: z.string().min(1),
  statement: z.string().min(1),
  resourceVersionId: z.string().uuid(),
  sourceRef: z.string().startsWith("wk://source/")
});
export type CourseKnowledgePoint = z.infer<typeof courseKnowledgePointSchema>;

export const courseUnitSchema = z.object({
  id: z.string().uuid(),
  planUnitId: z.string().min(1),
  ordinal: z.number().int().positive(),
  title: z.string().min(1),
  objective: z.string().min(1),
  completionRule: z.string().min(1),
  resourceVersionId: z.string().uuid(),
  sourceRef: z.string().startsWith("wk://source/"),
  knowledgePoints: z.array(courseKnowledgePointSchema).min(1)
});
export type CourseUnit = z.infer<typeof courseUnitSchema>;

export const courseModuleSchema = z.object({
  id: z.string().uuid(),
  ordinal: z.number().int().positive(),
  title: z.string().min(1),
  objective: z.string().min(1),
  units: z.array(courseUnitSchema).min(1)
});
export type CourseModule = z.infer<typeof courseModuleSchema>;

export const learningCourseSchema = z.object({
  id: z.string().uuid(),
  learningPlanId: z.string().uuid(),
  status: z.enum(["active", "archived"]),
  title: z.string().min(1),
  goal: z.string().min(1),
  createdAt: z.string().datetime(),
  modules: z.array(courseModuleSchema).min(1)
});
export type LearningCourse = z.infer<typeof learningCourseSchema>;

export const practiceDifficultySchema = z.enum(["easy", "standard", "challenge"]);
export type PracticeDifficulty = z.infer<typeof practiceDifficultySchema>;

export const createPracticeCandidateInputSchema = z.object({
  courseUnitIds: z.array(z.string().uuid()).min(1).max(8),
  difficulty: practiceDifficultySchema.default("standard")
});
export type CreatePracticeCandidateInput = z.infer<typeof createPracticeCandidateInputSchema>;

export const practiceRubricSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("free_response"),
    criteria: z.array(z.string().min(1)).min(1),
    maximumScore: z.number().int().positive(),
    note: z.string().min(1)
  }),
  z.object({
    kind: z.literal("exact_response"),
    normalization: z.literal("nfkc_trim_casefold_whitespace"),
    maximumScore: z.literal(1),
    note: z.string().min(1)
  })
]);
export type PracticeRubric = z.infer<typeof practiceRubricSchema>;

export const practiceGenerateCandidateQuestionSchema = z.discriminatedUnion("answerType", [
  z.object({
    courseUnitId: z.string().uuid(),
    knowledgePointId: z.string().uuid(),
    resourceVersionId: z.string().uuid(),
    sourceRef: z.string().startsWith("wk://source/"),
    answerType: z.literal("exact_response"),
    prompt: z.string().trim().min(1).max(2_000),
    answerKey: z.string().trim().min(1).max(2_000),
    rubric: z.object({
      kind: z.literal("exact_response"),
      normalization: z.literal("nfkc_trim_casefold_whitespace"),
      maximumScore: z.literal(1),
      note: z.string().trim().min(1).max(1_000)
    })
  }),
  z.object({
    courseUnitId: z.string().uuid(),
    knowledgePointId: z.string().uuid(),
    resourceVersionId: z.string().uuid(),
    sourceRef: z.string().startsWith("wk://source/"),
    answerType: z.literal("free_response"),
    prompt: z.string().trim().min(1).max(2_000),
    rubric: z.object({
      kind: z.literal("free_response"),
      criteria: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
      maximumScore: z.number().int().positive().max(100),
      note: z.string().trim().min(1).max(1_000)
    })
  })
]);
export type PracticeGenerateCandidateQuestion = z.infer<
  typeof practiceGenerateCandidateQuestionSchema
>;

export const practiceGenerateCandidatePreviewQuestionSchema = z.discriminatedUnion("answerType", [
  z.object({
    courseUnitId: z.string().uuid(),
    knowledgePointId: z.string().uuid(),
    resourceVersionId: z.string().uuid(),
    sourceRef: z.string().startsWith("wk://source/"),
    answerType: z.literal("exact_response"),
    prompt: z.string().min(1),
    rubric: z.object({
      kind: z.literal("exact_response"),
      normalization: z.literal("nfkc_trim_casefold_whitespace"),
      maximumScore: z.literal(1),
      note: z.string().min(1)
    })
  }),
  z.object({
    courseUnitId: z.string().uuid(),
    knowledgePointId: z.string().uuid(),
    resourceVersionId: z.string().uuid(),
    sourceRef: z.string().startsWith("wk://source/"),
    answerType: z.literal("free_response"),
    prompt: z.string().min(1),
    rubric: z.object({
      kind: z.literal("free_response"),
      criteria: z.array(z.string().min(1)).min(1),
      maximumScore: z.number().int().positive(),
      note: z.string().min(1)
    })
  })
]);
export type PracticeGenerateCandidatePreviewQuestion = z.infer<
  typeof practiceGenerateCandidatePreviewQuestionSchema
>;

export const practiceGenerateCandidateOutputSchema = z.object({
  courseId: z.string().uuid(),
  difficulty: practiceDifficultySchema,
  questions: z.array(practiceGenerateCandidateQuestionSchema).min(1).max(20)
});
export type PracticeGenerateCandidateOutput = z.infer<typeof practiceGenerateCandidateOutputSchema>;

export const skillRunProvenanceSchema = z.object({
  skillRunId: z.string().uuid(),
  skillId: z.string().min(1),
  skillVersion: z.string().min(1),
  skillDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/)
});
export type SkillRunProvenance = z.infer<typeof skillRunProvenanceSchema>;

export const practiceGenerateCandidateSchema = z.object({
  id: z.string().uuid(),
  skillRunId: z.string().uuid(),
  courseId: z.string().uuid(),
  difficulty: practiceDifficultySchema,
  questions: z.array(practiceGenerateCandidatePreviewQuestionSchema).min(1).max(20),
  materializedPracticeSetId: z.string().uuid().nullable(),
  createdAt: z.string().datetime()
});
export type PracticeGenerateCandidate = z.infer<typeof practiceGenerateCandidateSchema>;

export const materializePracticeGenerateCandidateInputSchema = z.object({
  candidateId: z.string().uuid()
});
export type MaterializePracticeGenerateCandidateInput = z.infer<
  typeof materializePracticeGenerateCandidateInputSchema
>;

export const practiceGradeSchema = z.object({
  id: z.string().uuid(),
  grader: z.enum(["objective_rule", "human_review"]),
  ruleVersion: z.enum(["exact_response.v1", "manual_rubric.v1"]),
  score: z.number().int().min(0),
  maximumScore: z.number().int().positive(),
  correct: z.boolean(),
  rationale: z.string().min(1).max(1000).nullable(),
  reviewedBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime()
});
export type PracticeGrade = z.infer<typeof practiceGradeSchema>;

export const submitManualFreeResponseReviewInputSchema = z.object({
  attemptType: z.enum(["practice", "assessment"]),
  score: z.number().int().min(0).max(100),
  rationale: z.string().trim().min(1).max(1000)
});
export type SubmitManualFreeResponseReviewInput = z.infer<
  typeof submitManualFreeResponseReviewInputSchema
>;

export const manualFreeResponseReviewItemSchema = z.object({
  attemptType: z.enum(["practice", "assessment"]),
  attemptId: z.string().uuid(),
  learnerUserId: z.string().uuid(),
  courseUnitId: z.string().uuid(),
  knowledgePointId: z.string().uuid(),
  resourceVersionId: z.string().uuid(),
  sourceRef: z.string().startsWith("wk://source/"),
  questionVersion: z.number().int().positive(),
  prompt: z.string().min(1),
  rubric: z.object({
    kind: z.literal("free_response"),
    criteria: z.array(z.string().min(1)).min(1),
    maximumScore: z.number().int().positive(),
    note: z.string().min(1)
  }),
  response: z.string().min(1),
  submittedAt: z.string().datetime()
});
export type ManualFreeResponseReviewItem = z.infer<typeof manualFreeResponseReviewItemSchema>;

export const practiceAttemptStatusSchema = z.enum(["pending_review", "graded"]);
export type PracticeAttemptStatus = z.infer<typeof practiceAttemptStatusSchema>;

export const submitPracticeAttemptInputSchema = z.object({
  response: z.string().trim().min(1).max(4000)
});
export type SubmitPracticeAttemptInput = z.infer<typeof submitPracticeAttemptInputSchema>;

export const practiceAttemptSchema = z.object({
  id: z.string().uuid(),
  practiceQuestionId: z.string().uuid(),
  courseUnitId: z.string().uuid(),
  knowledgePointId: z.string().uuid(),
  resourceVersionId: z.string().uuid(),
  sourceRef: z.string().startsWith("wk://source/"),
  questionVersion: z.number().int().positive(),
  prompt: z.string().min(1),
  rubric: practiceRubricSchema,
  response: z.string().min(1),
  status: practiceAttemptStatusSchema,
  grade: practiceGradeSchema.nullable(),
  submittedAt: z.string().datetime()
});
export type PracticeAttempt = z.infer<typeof practiceAttemptSchema>;

export const practiceMistakeReviewItemSchema = z.object({
  practiceQuestionId: z.string().uuid(),
  practiceAttemptId: z.string().uuid(),
  courseUnitId: z.string().uuid(),
  knowledgePointId: z.string().uuid(),
  resourceVersionId: z.string().uuid(),
  sourceRef: z.string().startsWith("wk://source/"),
  questionVersion: z.number().int().positive(),
  prompt: z.string().min(1),
  response: z.string().min(1),
  grade: practiceGradeSchema,
  submittedAt: z.string().datetime()
});
export type PracticeMistakeReviewItem = z.infer<typeof practiceMistakeReviewItemSchema>;

export const practiceQuestionSchema = z.object({
  id: z.string().uuid(),
  courseUnitId: z.string().uuid(),
  knowledgePointId: z.string().uuid(),
  resourceVersionId: z.string().uuid(),
  sourceRef: z.string().startsWith("wk://source/"),
  version: z.number().int().positive(),
  answerType: z.enum(["free_response", "exact_response"]),
  prompt: z.string().min(1),
  rubric: practiceRubricSchema,
  createdAt: z.string().datetime(),
  attempts: z.array(practiceAttemptSchema)
});
export type PracticeQuestion = z.infer<typeof practiceQuestionSchema>;

export const practiceSetSchema = z.object({
  id: z.string().uuid(),
  courseId: z.string().uuid(),
  status: z.literal("candidate"),
  difficulty: practiceDifficultySchema,
  generation: z.enum(["deterministic_template", "skill_candidate"]),
  provenance: skillRunProvenanceSchema.nullable(),
  createdAt: z.string().datetime(),
  questions: z.array(practiceQuestionSchema).min(1)
});
export type PracticeSet = z.infer<typeof practiceSetSchema>;

export const assessmentStatusSchema = z.enum(["draft", "active", "submitted"]);
export type AssessmentStatus = z.infer<typeof assessmentStatusSchema>;

export const createAssessmentInputSchema = z.object({
  practiceSetId: z.string().uuid()
});
export type CreateAssessmentInput = z.infer<typeof createAssessmentInputSchema>;

export const submitAssessmentAttemptInputSchema = z.object({
  assessmentQuestionId: z.string().uuid(),
  response: z.string().trim().min(1).max(4000)
});
export type SubmitAssessmentAttemptInput = z.infer<typeof submitAssessmentAttemptInputSchema>;

export const assessmentGradeSchema = practiceGradeSchema;
export type AssessmentGrade = z.infer<typeof assessmentGradeSchema>;

export const assessmentAttemptSchema = z.object({
  id: z.string().uuid(),
  assessmentQuestionId: z.string().uuid(),
  courseUnitId: z.string().uuid(),
  knowledgePointId: z.string().uuid(),
  resourceVersionId: z.string().uuid(),
  sourceRef: z.string().startsWith("wk://source/"),
  questionVersion: z.number().int().positive(),
  prompt: z.string().min(1),
  rubric: practiceRubricSchema,
  response: z.string().min(1),
  status: practiceAttemptStatusSchema,
  grade: assessmentGradeSchema.nullable(),
  submittedAt: z.string().datetime()
});
export type AssessmentAttempt = z.infer<typeof assessmentAttemptSchema>;

export const assessmentQuestionSchema = z.object({
  id: z.string().uuid(),
  ordinal: z.number().int().positive(),
  courseUnitId: z.string().uuid(),
  knowledgePointId: z.string().uuid(),
  resourceVersionId: z.string().uuid(),
  sourceRef: z.string().startsWith("wk://source/"),
  questionVersion: z.number().int().positive(),
  answerType: z.enum(["free_response", "exact_response"]),
  prompt: z.string().min(1),
  rubric: practiceRubricSchema,
  attempts: z.array(assessmentAttemptSchema).max(1)
});
export type AssessmentQuestion = z.infer<typeof assessmentQuestionSchema>;

export const assessmentSchema = z.object({
  id: z.string().uuid(),
  courseId: z.string().uuid(),
  practiceSetId: z.string().uuid(),
  status: assessmentStatusSchema,
  title: z.string().min(1),
  startedAt: z.string().datetime().nullable(),
  submittedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  questions: z.array(assessmentQuestionSchema).min(1)
});
export type Assessment = z.infer<typeof assessmentSchema>;

export const knowledgePointMasteryItemSchema = z.object({
  knowledgePointId: z.string().uuid(),
  status: z.enum(["ungraded", "graded"]),
  correct: z.boolean().nullable(),
  score: z.number().int().nonnegative().nullable(),
  maximumScore: z.number().int().positive().nullable(),
  percent: z.number().min(0).max(100).nullable(),
  updatedAt: z.string().datetime().nullable()
});
export type KnowledgePointMasteryItem = z.infer<typeof knowledgePointMasteryItemSchema>;

export const knowledgePointMasterySummarySchema = z.object({
  totalKnowledgePoints: z.number().int().nonnegative(),
  gradedKnowledgePoints: z.number().int().nonnegative(),
  currentCorrect: z.number().int().nonnegative(),
  averagePercent: z.number().min(0).max(100).nullable(),
  items: z.array(knowledgePointMasteryItemSchema)
});
export type KnowledgePointMasterySummary = z.infer<typeof knowledgePointMasterySummarySchema>;

export const learningProgressReportSchema = z.object({
  learningPlanId: z.string().uuid(),
  courseId: z.string().uuid(),
  units: z.object({
    total: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    completionPercent: z.number().min(0).max(100)
  }),
  practice: z.object({
    candidateSets: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    pendingReview: z.number().int().nonnegative(),
    objectiveGraded: z.number().int().nonnegative(),
    objectiveCorrect: z.number().int().nonnegative(),
    objectiveScore: z.number().int().nonnegative(),
    objectiveMaximumScore: z.number().int().nonnegative(),
    traceableAttempts: z.number().int().nonnegative()
  }),
  mastery: knowledgePointMasterySummarySchema
});
export type LearningProgressReport = z.infer<typeof learningProgressReportSchema>;

export const learningReportArtifactSchema = z.object({
  format: z.enum(["png", "pdf"]),
  byteSize: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime()
});
export type LearningReportArtifact = z.infer<typeof learningReportArtifactSchema>;

export const learningReportSnapshotSchema = z.object({
  id: z.string().uuid(),
  learningPlanId: z.string().uuid(),
  courseId: z.string().uuid(),
  report: learningProgressReportSchema,
  status: z.enum(["queued", "rendering", "completed", "failed"]),
  errorCode: z.string().min(1).nullable(),
  errorMessage: z.string().min(1).max(300).nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  artifacts: z.array(learningReportArtifactSchema).max(2)
});
export type LearningReportSnapshot = z.infer<typeof learningReportSnapshotSchema>;

export const queryRunCandidateSchema = z.object({
  evidenceId: evidenceIdSchema,
  pageId: wikiPageFrontmatterSchema.shape.id,
  pageTitle: z.string().min(1),
  pageType: wikiPageFrontmatterSchema.shape.type,
  rank: z.number().int().positive().max(10),
  sourceCount: z.number().int().nonnegative(),
  cited: z.boolean()
});
export type QueryRunCandidate = z.infer<typeof queryRunCandidateSchema>;

export const queryRunModelCallSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  providerId: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  capability: z.literal("chat"),
  durationMs: z.number().int().nonnegative(),
  errorCode: z.string().min(1).nullable()
});
export type QueryRunModelCall = z.infer<typeof queryRunModelCallSchema>;

export const queryRunAuditSchema = z.object({
  id: z.string().uuid(),
  questionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  questionLength: z.number().int().min(2).max(4_000),
  answerMode: groundedAnswerSchema.shape.mode,
  insufficientEvidence: z.boolean(),
  searchedPages: z.number().int().nonnegative(),
  embeddingCalls: z.literal(0),
  durationMs: z.number().int().nonnegative(),
  candidates: z.array(queryRunCandidateSchema).max(10),
  modelCall: queryRunModelCallSchema.nullable()
});
export type QueryRunAudit = z.infer<typeof queryRunAuditSchema>;

export const managedQueryRunSchema = queryRunAuditSchema
  .omit({
    candidates: true,
    modelCall: true
  })
  .extend({
    organizationId: z.string().uuid(),
    spaceId: z.string().uuid(),
    spaceName: z.string().min(1),
    userId: z.string().uuid().nullable(),
    candidateCount: z.number().int().nonnegative(),
    citedCount: z.number().int().nonnegative(),
    modelCall: queryRunModelCallSchema.nullable(),
    createdAt: z.string().datetime({ offset: true })
  });
export type ManagedQueryRun = z.infer<typeof managedQueryRunSchema>;

export const queryRunListInputSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

export const auditExportInputSchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).default(1_000)
});
export type AuditExportInput = z.infer<typeof auditExportInputSchema>;

export const auditExportRecordSchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string().datetime({ offset: true }),
  action: z.string().min(1).max(120),
  targetType: z.string().min(1).max(120),
  targetId: z.string().min(1).max(200),
  actorUserId: z.string().uuid().nullable()
});
export type AuditExportRecord = z.infer<typeof auditExportRecordSchema>;

export const wikiGoldenQuestionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    question: z.string().min(2).max(4_000),
    language: z.enum(["zh-CN", "en"]),
    questionType: z.enum(["fact", "routing", "case", "cross_section", "unanswerable"]),
    expectRefusal: z.boolean(),
    expectedPageIds: z.array(wikiPageFrontmatterSchema.shape.id),
    expectedResourceVersionIds: z.array(z.string().uuid()),
    expectedSourceRefs: z.array(z.string().startsWith("wk://source/")).default([])
  })
  .superRefine((question, context) => {
    const carriesTargets =
      question.expectedPageIds.length > 0 ||
      question.expectedResourceVersionIds.length > 0 ||
      question.expectedSourceRefs.length > 0;
    if (question.expectRefusal && carriesTargets)
      context.addIssue({
        code: "custom",
        message: "REFUSAL_EXPECTATION_CANNOT_CARRY_TARGETS",
        path: ["expectedPageIds"]
      });
    if (!question.expectRefusal && !carriesTargets)
      context.addIssue({
        code: "custom",
        message: "ANSWERABLE_EXPECTATION_REQUIRES_TARGETS",
        path: ["expectedPageIds"]
      });
    if (
      !question.expectRefusal &&
      (question.expectedPageIds.length === 0 || question.expectedResourceVersionIds.length === 0)
    )
      context.addIssue({
        code: "custom",
        message: "ANSWERABLE_EXPECTATION_REQUIRES_PAGE_AND_VERSION",
        path: ["expectedPageIds"]
      });
  });
export type WikiGoldenQuestion = z.infer<typeof wikiGoldenQuestionSchema>;

export const wikiGoldenDatasetSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
    stage: z.enum(["pilot", "development", "blind"]),
    description: z.string().min(1),
    thresholds: z.object({
      recallAt10: z.number().min(0).max(1),
      citationAccuracy: z.number().min(0).max(1),
      refusalAccuracy: z.number().min(0).max(1),
      sourceLocatorAccuracy: z.number().min(0).max(1).default(0)
    }),
    documents: z
      .array(
        z.object({
          id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
          spaceId: z.string().uuid(),
          resourceVersionId: z.string().uuid(),
          resourceName: z.string().min(1),
          profile: wikiCompileProfileSchema,
          nodes: z.array(compiledNodeSchema).min(1)
        })
      )
      .min(1),
    questions: z.array(wikiGoldenQuestionSchema).min(1)
  })
  .superRefine((dataset, context) => {
    const documentIds = new Set<string>();
    const versionIds = new Set<string>();
    for (const [index, document] of dataset.documents.entries()) {
      if (documentIds.has(document.id))
        context.addIssue({
          code: "custom",
          message: "GOLDEN_DOCUMENT_ID_DUPLICATE",
          path: ["documents", index, "id"]
        });
      documentIds.add(document.id);
      if (versionIds.has(document.resourceVersionId))
        context.addIssue({
          code: "custom",
          message: "GOLDEN_RESOURCE_VERSION_DUPLICATE",
          path: ["documents", index, "resourceVersionId"]
        });
      versionIds.add(document.resourceVersionId);
      if (
        document.nodes.some((node) => node.locator.resourceVersionId !== document.resourceVersionId)
      )
        context.addIssue({
          code: "custom",
          message: "GOLDEN_DOCUMENT_SOURCE_VERSION_MISMATCH",
          path: ["documents", index, "nodes"]
        });
    }
    const questionIds = new Set<string>();
    for (const [index, question] of dataset.questions.entries()) {
      if (questionIds.has(question.id))
        context.addIssue({
          code: "custom",
          message: "GOLDEN_QUESTION_ID_DUPLICATE",
          path: ["questions", index, "id"]
        });
      questionIds.add(question.id);
      for (const versionId of question.expectedResourceVersionIds)
        if (!versionIds.has(versionId))
          context.addIssue({
            code: "custom",
            message: "GOLDEN_EXPECTED_VERSION_UNKNOWN",
            path: ["questions", index, "expectedResourceVersionIds"]
          });
    }
  });
export type WikiGoldenDataset = z.infer<typeof wikiGoldenDatasetSchema>;

export const wikiGoldenReviewStatusSchema = z.enum(["draft", "approved", "revoked"]);
export type WikiGoldenReviewStatus = z.infer<typeof wikiGoldenReviewStatusSchema>;

export const wikiGoldenDocumentReviewSchema = z.object({
  documentId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  authorizationRefId: z.string().min(6).max(160),
  redactionReviewRefId: z.string().min(6).max(160),
  reviewerId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  reviewedAt: z.string().datetime({ offset: true })
});
export type WikiGoldenDocumentReview = z.infer<typeof wikiGoldenDocumentReviewSchema>;

export const wikiGoldenQuestionReviewSchema = z.object({
  questionId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  annotationRefId: z.string().min(6).max(160),
  annotatorId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  reviewerId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  reviewedAt: z.string().datetime({ offset: true }),
  expectedPageIds: z.array(wikiPageFrontmatterSchema.shape.id),
  expectedResourceVersionIds: z.array(z.string().uuid()),
  expectedSourceRefs: z.array(z.string().startsWith("wk://source/"))
});
export type WikiGoldenQuestionReview = z.infer<typeof wikiGoldenQuestionReviewSchema>;

export const wikiGoldenReviewManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    datasetId: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
    datasetSha256: z.string().regex(/^[a-f0-9]{64}$/),
    stage: z.enum(["development", "blind"]),
    status: wikiGoldenReviewStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
    approvedAt: z.string().datetime({ offset: true }).nullable(),
    documentReviews: z.array(wikiGoldenDocumentReviewSchema),
    questionReviews: z.array(wikiGoldenQuestionReviewSchema)
  })
  .superRefine((manifest, context) => {
    if (manifest.status === "approved" && !manifest.approvedAt)
      context.addIssue({
        code: "custom",
        message: "APPROVED_REVIEW_REQUIRES_APPROVED_AT",
        path: ["approvedAt"]
      });
    if (manifest.status !== "approved" && manifest.approvedAt)
      context.addIssue({
        code: "custom",
        message: "UNAPPROVED_REVIEW_CANNOT_CARRY_APPROVED_AT",
        path: ["approvedAt"]
      });
    const documentIds = new Set<string>();
    for (const [index, review] of manifest.documentReviews.entries()) {
      if (documentIds.has(review.documentId))
        context.addIssue({
          code: "custom",
          message: "GOLDEN_DOCUMENT_REVIEW_DUPLICATE",
          path: ["documentReviews", index, "documentId"]
        });
      documentIds.add(review.documentId);
    }
    const questionIds = new Set<string>();
    for (const [index, review] of manifest.questionReviews.entries()) {
      if (questionIds.has(review.questionId))
        context.addIssue({
          code: "custom",
          message: "GOLDEN_QUESTION_REVIEW_DUPLICATE",
          path: ["questionReviews", index, "questionId"]
        });
      questionIds.add(review.questionId);
    }
  });
export type WikiGoldenReviewManifest = z.infer<typeof wikiGoldenReviewManifestSchema>;

export const wikiGoldenCaseResultSchema = z.object({
  id: z.string(),
  question: z.string(),
  expectRefusal: z.boolean(),
  actualRefusal: z.boolean(),
  expectedPageIds: z.array(z.string()),
  expectedSourceRefs: z.array(z.string()),
  actualPageIds: z.array(z.string()),
  pageHit: z.boolean(),
  citationCorrect: z.boolean(),
  sourceLocatorCorrect: z.boolean(),
  embeddingCalls: z.literal(0),
  failureReasons: z.array(z.string())
});
export type WikiGoldenCaseResult = z.infer<typeof wikiGoldenCaseResultSchema>;

export const wikiGoldenReportSchema = z.object({
  schemaVersion: z.literal(1),
  datasetId: z.string(),
  stage: z.enum(["pilot", "development", "blind"]),
  documentCount: z.number().int().positive(),
  questionCount: z.number().int().positive(),
  answerableCount: z.number().int().nonnegative(),
  refusalCount: z.number().int().nonnegative(),
  metrics: z.object({
    recallAt10: z.number().min(0).max(1),
    citationAccuracy: z.number().min(0).max(1),
    sourceLocatorAccuracy: z.number().min(0).max(1),
    sourceLocatorEvaluatedCount: z.number().int().nonnegative(),
    refusalAccuracy: z.number().min(0).max(1),
    answerableAccuracy: z.number().min(0).max(1),
    embeddingCalls: z.literal(0)
  }),
  thresholdsPassed: z.boolean(),
  cases: z.array(wikiGoldenCaseResultSchema)
});
export type WikiGoldenReport = z.infer<typeof wikiGoldenReportSchema>;

export const apiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  suggestion: z.string().optional(),
  requestId: z.string(),
  details: z.unknown().optional()
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const jobStatusSchema = z.enum([
  "queued",
  "processing",
  "cancel_requested",
  "cancelled",
  "completed",
  "failed"
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const processingJobSchema = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  resourceVersionId: z.string().uuid().nullable(),
  kind: z.string().min(1),
  status: jobStatusSchema,
  stage: z.string().min(1),
  progress: z.number().int().min(0).max(100),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true })
});
export type ProcessingJob = z.infer<typeof processingJobSchema>;

export const queueHealthSchema = z.object({
  name: z.string().min(1),
  queuedCount: z.number().int().nonnegative(),
  activeCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative()
});
export type QueueHealth = z.infer<typeof queueHealthSchema>;

export const deadLetterJobSummarySchema = z.object({
  id: z.string().uuid(),
  sourceName: z.string().min(1).nullable(),
  retryCount: z.number().int().nonnegative().nullable(),
  createdAt: z.string().datetime({ offset: true })
});
export type DeadLetterJobSummary = z.infer<typeof deadLetterJobSummarySchema>;

export const deadLetterQueueHealthSchema = z.object({
  processing: queueHealthSchema,
  deadLetter: queueHealthSchema,
  oldestDeadLetterAt: z.string().datetime({ offset: true }).nullable(),
  jobs: z.array(deadLetterJobSummarySchema).max(20)
});
export type DeadLetterQueueHealth = z.infer<typeof deadLetterQueueHealthSchema>;

export const redriveDeadLetterInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25)
});

export const blobAuditSummarySchema = z.object({
  checkedAt: z.string().datetime({ offset: true }),
  referencedCount: z.number().int().nonnegative(),
  inventoryCount: z.number().int().nonnegative(),
  verifiedReferenceCount: z.number().int().nonnegative(),
  missingReferenceCount: z.number().int().nonnegative(),
  unreferencedBlobCount: z.number().int().nonnegative(),
  uncheckedReferenceCount: z.number().int().nonnegative(),
  missingResourceVersionIds: z.array(z.string().uuid()).max(20),
  unreferencedUriDigests: z.array(z.string().length(16)).max(20)
});
export type BlobAuditSummary = z.infer<typeof blobAuditSummarySchema>;

export const storageUsageSchema = z.object({
  quotaBytes: z.number().int().positive(),
  usedBytes: z.number().int().nonnegative(),
  reservedBytes: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative()
});
export type StorageUsage = z.infer<typeof storageUsageSchema>;

export const loginInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});
export const requestSignupCodeInputSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.trim().toLowerCase())
});
export const completeSignupInputSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.trim().toLowerCase()),
  code: z.string().regex(/^\d{6}$/),
  name: z.string().trim().min(2).max(80),
  password: z.string().min(8).max(200)
});
export const createInvitationInputSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase()),
  organizationRole: roleSchema.refine((role) => role !== "owner"),
  spaceId: z.string().uuid().optional(),
  spaceRole: roleSchema.optional()
});
export const acceptInvitationInputSchema = z.object({
  token: z.string().min(32).max(256),
  name: z.string().trim().min(2).max(80),
  password: z.string().min(8).max(200).optional()
});
export const updateUserDisabledInputSchema = z.object({ disabled: z.boolean() });
export const updateSpaceMemberInputSchema = z.object({
  role: roleSchema.refine((role) => role !== "owner")
});
export const createSpaceInputSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).default(""),
  dataPolicy: dataPolicySchema.default("local_only")
});
export const queryInputSchema = z.object({ question: z.string().min(2).max(4_000) });

export const agentSessionStatusSchema = z.enum(["active", "archived"]);
export type AgentSessionStatus = z.infer<typeof agentSessionStatusSchema>;

export const agentContextBindingStatusSchema = z.enum(["active", "removed", "revoked"]);
export type AgentContextBindingStatus = z.infer<typeof agentContextBindingStatusSchema>;

export const agentContextScopeSchema = z.enum(["space", "wiki_page", "resource_version", "course"]);
export type AgentContextScope = z.infer<typeof agentContextScopeSchema>;

export const agentMessageRoleSchema = z.enum(["user", "assistant"]);
export type AgentMessageRole = z.infer<typeof agentMessageRoleSchema>;

export const agentRunStatusSchema = z.enum(["running", "completed", "failed", "stopped"]);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentRunEventTypeSchema = z.enum([
  "run.started",
  "tool.requested",
  "tool.completed",
  "run.completed",
  "run.failed",
  "run.stopped"
]);
export type AgentRunEventType = z.infer<typeof agentRunEventTypeSchema>;

export const agentRunEventSchema = z
  .object({
    id: z.string().uuid(),
    agentRunId: z.string().uuid(),
    sequence: z.number().int().positive(),
    type: agentRunEventTypeSchema,
    tool: z.enum(["knowledge.search", "knowledge.read"]).nullable(),
    inputSummary: z.string().min(1).max(300).nullable(),
    outputSummary: z.string().min(1).max(300).nullable(),
    status: agentRunStatusSchema.nullable(),
    createdAt: z.string().datetime()
  })
  .superRefine((event, context) => {
    const toolEvent = event.type === "tool.requested" || event.type === "tool.completed";
    if (toolEvent !== Boolean(event.tool))
      context.addIssue({ code: "custom", message: "AGENT_RUN_EVENT_TOOL_INVALID" });
    if (event.type === "tool.requested" && (!event.inputSummary || event.outputSummary))
      context.addIssue({ code: "custom", message: "AGENT_RUN_EVENT_INPUT_INVALID" });
    if (event.type === "tool.completed" && (!event.outputSummary || event.inputSummary))
      context.addIssue({ code: "custom", message: "AGENT_RUN_EVENT_OUTPUT_INVALID" });
    if (toolEvent ? event.status !== null : event.status === null)
      context.addIssue({ code: "custom", message: "AGENT_RUN_EVENT_STATUS_INVALID" });
    if (event.type === "run.started" && event.status !== "running")
      context.addIssue({ code: "custom", message: "AGENT_RUN_EVENT_STATUS_INVALID" });
    if (event.type === "run.completed" && event.status !== "completed")
      context.addIssue({ code: "custom", message: "AGENT_RUN_EVENT_STATUS_INVALID" });
    if (event.type === "run.failed" && event.status !== "failed")
      context.addIssue({ code: "custom", message: "AGENT_RUN_EVENT_STATUS_INVALID" });
    if (event.type === "run.stopped" && event.status !== "stopped")
      context.addIssue({ code: "custom", message: "AGENT_RUN_EVENT_STATUS_INVALID" });
  });
export type AgentRunEvent = z.infer<typeof agentRunEventSchema>;

export const agentKnowledgeToolCallSchema = z.object({
  id: z.string().uuid(),
  agentRunId: z.string().uuid(),
  name: z.enum(["knowledge.search", "knowledge.read"]),
  bindingIds: z.array(z.string().uuid()).min(1).max(8),
  inputSummary: z.string().min(1).max(500),
  outputSummary: z.string().min(1).max(500),
  resultCount: z.number().int().nonnegative(),
  searchedPages: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  completedAt: z.string().datetime()
});
export type AgentKnowledgeToolCall = z.infer<typeof agentKnowledgeToolCallSchema>;

export const createAgentContextBindingInputSchema = z.discriminatedUnion("scope", [
  z.object({ spaceId: z.string().uuid(), scope: z.literal("space") }).strict(),
  z
    .object({
      spaceId: z.string().uuid(),
      scope: z.literal("wiki_page"),
      targetId: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/)
    })
    .strict(),
  z
    .object({
      spaceId: z.string().uuid(),
      scope: z.literal("resource_version"),
      targetId: z.string().uuid()
    })
    .strict(),
  z
    .object({
      spaceId: z.string().uuid(),
      scope: z.literal("course"),
      targetId: z.string().uuid()
    })
    .strict()
]);
export type CreateAgentContextBindingInput = z.infer<typeof createAgentContextBindingInputSchema>;

export const createAgentSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  bindings: z
    .array(createAgentContextBindingInputSchema)
    .min(1)
    .max(8)
    .superRefine((bindings, context) => {
      const keys = bindings.map(
        (binding) =>
          `${binding.spaceId}:${binding.scope}:${binding.scope === "space" ? "" : binding.targetId}`
      );
      if (new Set(keys).size !== keys.length)
        context.addIssue({ code: "custom", message: "AGENT_CONTEXT_BINDING_DUPLICATE" });
    })
});
export type CreateAgentSessionInput = z.infer<typeof createAgentSessionInputSchema>;

export const updateAgentSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  status: agentSessionStatusSchema.optional()
});
export type UpdateAgentSessionInput = z.infer<typeof updateAgentSessionInputSchema>;

export const createAgentMessageInputSchema = z.object({
  message: z.string().trim().min(2).max(4_000)
});
export type CreateAgentMessageInput = z.infer<typeof createAgentMessageInputSchema>;

export const agentContextBindingSchema = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  scope: agentContextScopeSchema,
  targetId: z.string().nullable(),
  label: z.string().min(1),
  virtualPath: z
    .string()
    .regex(
      /^\/knowledge\/[0-9a-f-]{36}(?:\/(?:wiki\/pages\/[a-z0-9][a-z0-9_-]*|resources\/[0-9a-f-]{36}|courses\/[0-9a-f-]{36}))?$/
    ),
  status: agentContextBindingStatusSchema,
  createdAt: z.string().datetime()
});
export type AgentContextBinding = z.infer<typeof agentContextBindingSchema>;

export const agentMessageSchema = z.object({
  id: z.string().uuid(),
  role: agentMessageRoleSchema,
  content: z.string().min(1).max(8_000),
  createdAt: z.string().datetime()
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

export const agentEvidenceSnapshotSchema = z.object({
  id: z.string().uuid(),
  evidenceId: z.string().min(1),
  spaceId: z.string().uuid(),
  pageId: z.string().min(1),
  pageTitle: z.string().min(1),
  pageType: wikiPageFrontmatterSchema.shape.type,
  rank: z.number().int().positive(),
  sourceCount: z.number().int().nonnegative(),
  sourceRefs: z.array(z.string().startsWith("wk://")).max(32),
  cited: z.boolean()
});
export type AgentEvidenceSnapshot = z.infer<typeof agentEvidenceSnapshotSchema>;

export const agentRunSchema = z.object({
  id: z.string().uuid(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid().nullable(),
  status: agentRunStatusSchema,
  answerMode: groundedAnswerSchema.shape.mode.nullable(),
  insufficientEvidence: z.boolean().nullable(),
  searchedPages: z.number().int().nonnegative(),
  embeddingCalls: z.literal(0),
  durationMs: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  evidence: z.array(agentEvidenceSnapshotSchema).max(80)
});
export type AgentRun = z.infer<typeof agentRunSchema>;

export const agentSessionSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  status: agentSessionStatusSchema,
  bindingCount: z.number().int().nonnegative(),
  lastMessageAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type AgentSessionSummary = z.infer<typeof agentSessionSummarySchema>;

export const agentRunStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run.started"),
    runId: z.string().uuid(),
    userMessage: agentMessageSchema
  }),
  z.object({
    type: z.literal("tool.requested"),
    runId: z.string().uuid(),
    tool: z.enum(["knowledge.search", "knowledge.read"]),
    inputSummary: z.string().min(1).max(300)
  }),
  z.object({
    type: z.literal("tool.completed"),
    runId: z.string().uuid(),
    tool: z.enum(["knowledge.search", "knowledge.read"]),
    outputSummary: z.string().min(1).max(300)
  }),
  z.object({
    type: z.literal("assistant.delta"),
    runId: z.string().uuid(),
    text: z.string().min(1).max(800)
  }),
  z.object({
    type: z.literal("run.completed"),
    runId: z.string().uuid(),
    result: groundedQueryResultSchema,
    run: agentRunSchema,
    assistantMessageId: z.string().uuid()
  }),
  z.object({ type: z.literal("run.stopped"), runId: z.string().uuid() }),
  z.object({
    type: z.literal("run.failed"),
    runId: z.string().uuid(),
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(300)
  })
]);
export type AgentRunStreamEvent = z.infer<typeof agentRunStreamEventSchema>;

export const recompileResourceInputSchema = z.object({
  compileProfile: wikiCompileProfileSchema
});
export type RecompileResourceInput = z.infer<typeof recompileResourceInputSchema>;

const uploadSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const createChunkedUploadInputSchema = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().min(3).max(255),
  byteSize: z
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024),
  sha256: uploadSha256Schema,
  compileProfile: wikiCompileProfileSchema.default("knowledge")
});
export type CreateChunkedUploadInput = z.infer<typeof createChunkedUploadInputSchema>;

export const completeChunkedUploadInputSchema = z.object({
  sha256: uploadSha256Schema
});
export type CompleteChunkedUploadInput = z.infer<typeof completeChunkedUploadInputSchema>;

export interface WikiCitation {
  pageId: string;
  title: string;
  sourceRefs: string[];
}

export interface WikiQueryResult {
  answer: string;
  citations: WikiCitation[];
  searchedPages: number;
  refused: boolean;
}
