import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import {
  CURRENT_WIKI_SCHEMA_VERSION,
  inspectWikiSchema,
  writeCurrentWikiSchemaManifest
} from "./schema-lifecycle";
import {
  compiledDocumentSchema,
  evidenceBundleSchema,
  sourceLocatorSchema,
  wikiPageFrontmatterSchema,
  type CompiledNode,
  type CreateWikiConflictInput,
  type EvidenceBundle,
  type SourceLocator,
  type WikiConflictDecisionInput,
  type WikiConflictDetail,
  type WikiConflictSummary,
  type WikiPageChangeProposalDetail,
  type WikiPageChangeProposalSummary,
  type WikiPageDiffLine,
  type WikiPageDetail,
  type WikiPageFrontmatter,
  type WikiPageListQuery,
  type WikiPageRevisionSummary,
  type WikiPageSummary,
  type WikiProposalDecisionInput,
  type WikiQueryResult,
  type WikiReviewInput,
  type WikiCompileProfile,
  wikiPageChangeProposalSummarySchema,
  wikiPageRevisionSummarySchema,
  wikiConflictSummarySchema
} from "@wknowledge/contracts";

export type { CompiledNode } from "@wknowledge/contracts";

export interface CompileWikiInput {
  spaceId: string;
  resourceVersionId: string;
  resourceName: string;
  profile: WikiCompileProfile;
  nodes: CompiledNode[];
  compiledAt?: Date;
}

export interface CompiledWikiPage {
  pageId: string;
  pagePath: string;
  type: WikiPageFrontmatter["type"];
}

export interface ReviewWikiPageInput extends WikiReviewInput {
  pageId: string;
  reviewerId: string;
  reviewedAt?: Date;
}

export interface DecideWikiPageProposalInput extends WikiProposalDecisionInput {
  pageId: string;
  proposalId: string;
  reviewerId: string;
  reviewedAt?: Date;
}

export interface WikiProposalDecisionResult {
  page: WikiPageDetail;
  proposal: WikiPageChangeProposalSummary;
}

export interface DeclareWikiConflictInput extends CreateWikiConflictInput {
  actorUserId: string;
  createdAt?: Date;
}

export interface DecideWikiConflictInput extends WikiConflictDecisionInput {
  conflictId: string;
  actorUserId: string;
  decidedAt?: Date;
}

export interface WikiLintIssue {
  file: string;
  code: string;
  message: string;
}

export interface WikiSchemaMigrationResult {
  status: "already_current" | "migrated";
  wikiSchemaVersion: 1;
}

export interface WikiEvidenceFilter {
  pageIds?: readonly string[];
  resourceVersionIds?: readonly string[];
}

const WIKI_DIRS = ["concepts", "topics", "cases", "courses", "materials", "indexes"];

interface WikiProposalManifest extends WikiPageChangeProposalSummary {
  schemaVersion: 1;
  sourceMappings: Array<{ nodeId: string; locator: SourceLocator }>;
}

interface WikiConflictManifest extends WikiConflictSummary {
  schemaVersion: 1;
}

export const locatorRef = (locator: SourceLocator): string => {
  const encoded = Buffer.from(JSON.stringify(locator)).toString("base64url");
  return `wk://source/${locator.resourceVersionId}/${encoded}`;
};

export const parseLocatorRef = (ref: string): SourceLocator => {
  const encoded = ref.split("/").at(-1);
  if (!encoded || !ref.startsWith("wk://source/")) throw new Error("SOURCE_REF_INVALID");
  return sourceLocatorSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
};

const slug = (value: string): string =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "") || "material";

export function renderCompiledContent(nodes: CompiledNode[]): string {
  const blocks = nodes.map((node) => {
    if (node.kind === "heading") {
      const rawLevel = node.metadata.level;
      const level =
        typeof rawLevel === "number" && Number.isInteger(rawLevel)
          ? Math.max(1, Math.min(6, rawLevel))
          : 2;
      const title = node.title ?? node.content.trim();
      const body = node.content.trim() === title ? "" : `\n\n${node.content.trim()}`;
      return `${"#".repeat(level)} ${title}${body}`;
    }
    const title = node.title ? `## ${node.title}\n\n` : "";
    return `${title}${node.content.trim()}`;
  });
  return `${blocks.join("\n\n")}\n`;
}

export async function initializeSpace(root: string, spaceId: string): Promise<string> {
  const spaceRoot = path.join(root, spaceId);
  await Promise.all([
    mkdir(path.join(spaceRoot, "raw"), { recursive: true }),
    mkdir(path.join(spaceRoot, "compiled"), { recursive: true }),
    mkdir(path.join(spaceRoot, "mappings"), { recursive: true }),
    mkdir(path.join(spaceRoot, "reviews", "pages"), { recursive: true }),
    mkdir(path.join(spaceRoot, "reviews", "conflicts"), { recursive: true }),
    ...WIKI_DIRS.map((dir) => mkdir(path.join(spaceRoot, "wiki", dir), { recursive: true }))
  ]);
  await writeIfMissing(
    path.join(spaceRoot, "KNOWLEDGE.md"),
    `# Knowledge space ${spaceId}\n\nStart with \`wiki/index.md\`.\n`
  );
  await writeIfMissing(
    path.join(spaceRoot, "wiki", "index.md"),
    "# Knowledge index\n\nNo materials have been compiled.\n"
  );
  await writeIfMissing(path.join(spaceRoot, "wiki", "log.md"), "# Wiki compilation log\n");
  await writeIfMissing(
    path.join(spaceRoot, "wiki", "schema-manifest.json"),
    `${JSON.stringify(
      {
        manifestSchemaVersion: 1,
        wikiSchemaVersion: 1,
        generatedAt: new Date().toISOString(),
        generatedBy: "initialize"
      },
      null,
      2
    )}\n`
  );
  await writeIfMissing(path.join(spaceRoot, "mappings", "source-map.jsonl"), "");
  return spaceRoot;
}

export interface WikiPublicationRecoveryResult {
  restoredBackup?: string;
  removedArtifacts: string[];
}

export interface ManagedWikiPublicationRecovery {
  spaceId: string;
  recovery: WikiPublicationRecoveryResult;
}

const managedSpaceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Recovers only abandoned publish artifacts. It never modifies a published wiki,
 * raw evidence, compiled output, or review snapshots.
 */
export async function recoverWikiPublicationArtifacts(
  spaceRoot: string,
  staleAfterMs = 2 * 60 * 60 * 1_000
): Promise<WikiPublicationRecoveryResult> {
  const now = Date.now();
  const entries = await readdir(spaceRoot, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  );
  const artifacts = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (entry.name.startsWith(".wiki-staging-") || entry.name.startsWith(".wiki-backup-"))
      )
      .map(async (entry) => ({
        name: entry.name,
        path: path.join(spaceRoot, entry.name),
        modifiedAt: (await stat(path.join(spaceRoot, entry.name))).mtimeMs
      }))
  );
  const wikiRoot = path.join(spaceRoot, "wiki");
  const publishedWikiExists = await stat(wikiRoot)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  const backups = artifacts
    .filter((artifact) => artifact.name.startsWith(".wiki-backup-"))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  let restoredBackup: string | undefined;
  if (!publishedWikiExists && backups[0]) {
    await rename(backups[0].path, wikiRoot);
    restoredBackup = backups[0].name;
  }
  const removedArtifacts: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.name === restoredBackup || now - artifact.modifiedAt < staleAfterMs) continue;
    await rm(artifact.path, { recursive: true, force: true });
    removedArtifacts.push(artifact.name);
  }
  return { ...(restoredBackup ? { restoredBackup } : {}), removedArtifacts };
}

/**
 * Recovers artifacts from direct UUID space directories only. Callers that can
 * run concurrently should acquire their space publication lease in `recover`.
 */
export async function recoverWikiPublicationArtifactsInDataRoot(
  dataRoot: string,
  recover: (spaceId: string, spaceRoot: string) => Promise<WikiPublicationRecoveryResult | null> = (
    _spaceId,
    spaceRoot
  ) => recoverWikiPublicationArtifacts(spaceRoot)
): Promise<ManagedWikiPublicationRecovery[]> {
  const entries = await readdir(dataRoot, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  );
  const recoveries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && managedSpaceIdPattern.test(entry.name))
      .map(async (entry) => {
        const spaceRoot = path.join(dataRoot, entry.name);
        const recovery = await recover(entry.name, spaceRoot);
        return recovery ? { spaceId: entry.name, recovery } : null;
      })
  );
  return recoveries.filter(
    (recovery): recovery is ManagedWikiPublicationRecovery => recovery !== null
  );
}

async function writeIfMissing(file: string, content: string): Promise<void> {
  await writeFile(file, content, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

function serialize(frontmatter: WikiPageFrontmatter, content: string): string {
  const cleanFrontmatter = Object.fromEntries(
    Object.entries(frontmatter).filter(([, value]) => value !== undefined)
  );
  return matter.stringify(`${content.trim()}\n`, cleanFrontmatter);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function semanticPageDigest(metadata: WikiPageFrontmatter, content: string): string {
  const semanticMetadata = {
    schemaVersion: metadata.schemaVersion,
    id: metadata.id,
    title: metadata.title,
    type: metadata.type,
    aliases: metadata.aliases,
    tags: metadata.tags,
    sourceRefs: metadata.sourceRefs,
    related: metadata.related,
    sourceMarking: metadata.sourceMarking,
    compileProfile: metadata.compileProfile ?? null
  };
  return sha256(`${JSON.stringify(semanticMetadata)}\n${content.trim()}`);
}

function reviewPageRoot(spaceRoot: string, pageId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(pageId)) throw new Error("WIKI_PAGE_NOT_FOUND");
  return path.join(spaceRoot, "reviews", "pages", pageId);
}

function proposalRoot(spaceRoot: string, pageId: string, proposalId: string): string {
  if (!/^proposal-[a-f0-9]{24}$/.test(proposalId)) throw new Error("WIKI_PROPOSAL_NOT_FOUND");
  return path.join(reviewPageRoot(spaceRoot, pageId), "proposals", proposalId);
}

function revisionRoot(spaceRoot: string, pageId: string): string {
  return path.join(reviewPageRoot(spaceRoot, pageId), "revisions");
}

function conflictRoot(spaceRoot: string, conflictId?: string): string {
  const root = path.join(spaceRoot, "reviews", "conflicts");
  if (!conflictId) return root;
  if (!/^conflict-[a-f0-9]{24}$/.test(conflictId)) throw new Error("WIKI_CONFLICT_NOT_FOUND");
  return path.join(root, conflictId);
}

async function readWikiConflictManifest(
  spaceRoot: string,
  conflictId: string
): Promise<WikiConflictManifest | null> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(conflictRoot(spaceRoot, conflictId), "manifest.json"), "utf8")
    );
    const summary = wikiConflictSummarySchema.parse(raw);
    if ((raw as { schemaVersion?: unknown }).schemaVersion !== 1)
      throw new Error("WIKI_CONFLICT_INVALID");
    return { ...summary, schemaVersion: 1 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeWikiConflictManifest(
  spaceRoot: string,
  manifest: WikiConflictManifest
): Promise<void> {
  await writeFile(
    path.join(conflictRoot(spaceRoot, manifest.id), "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

function conflictSummary(manifest: WikiConflictManifest): WikiConflictSummary {
  return wikiConflictSummarySchema.parse({
    id: manifest.id,
    status: manifest.status,
    leftPageId: manifest.leftPageId,
    rightPageId: manifest.rightPageId,
    createdAt: manifest.createdAt,
    createdBy: manifest.createdBy,
    ...(manifest.resolvedAt ? { resolvedAt: manifest.resolvedAt } : {}),
    ...(manifest.resolvedBy ? { resolvedBy: manifest.resolvedBy } : {}),
    ...(manifest.resolution ? { resolution: manifest.resolution } : {})
  });
}

function proposalSummary(manifest: WikiProposalManifest): WikiPageChangeProposalSummary {
  return wikiPageChangeProposalSummarySchema.parse({
    id: manifest.id,
    pageId: manifest.pageId,
    status: manifest.status,
    createdAt: manifest.createdAt,
    ...(manifest.resolvedAt ? { resolvedAt: manifest.resolvedAt } : {}),
    ...(manifest.resolvedBy ? { resolvedBy: manifest.resolvedBy } : {}),
    baseDigest: manifest.baseDigest,
    candidateDigest: manifest.candidateDigest,
    changedLineCount: manifest.changedLineCount,
    sourceCount: manifest.sourceCount
  });
}

async function readProposalManifest(
  spaceRoot: string,
  pageId: string,
  proposalId: string
): Promise<WikiProposalManifest | null> {
  const directory = proposalRoot(spaceRoot, pageId, proposalId);
  try {
    const raw = JSON.parse(
      await readFile(path.join(directory, "manifest.json"), "utf8")
    ) as unknown;
    const summary = wikiPageChangeProposalSummarySchema.parse(raw);
    if ((raw as { schemaVersion?: unknown }).schemaVersion !== 1 || summary.pageId !== pageId)
      throw new Error("WIKI_PROPOSAL_INVALID");
    const sourceMappings = (raw as { sourceMappings?: unknown }).sourceMappings;
    if (!Array.isArray(sourceMappings)) throw new Error("WIKI_PROPOSAL_INVALID");
    return {
      ...summary,
      schemaVersion: 1,
      sourceMappings: sourceMappings.map((mapping) => {
        if (
          !mapping ||
          typeof mapping !== "object" ||
          typeof (mapping as { nodeId?: unknown }).nodeId !== "string"
        )
          throw new Error("WIKI_PROPOSAL_INVALID");
        return {
          nodeId: (mapping as { nodeId: string }).nodeId,
          locator: sourceLocatorSchema.parse((mapping as { locator?: unknown }).locator)
        };
      })
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeProposalManifest(
  spaceRoot: string,
  manifest: WikiProposalManifest
): Promise<void> {
  const directory = proposalRoot(spaceRoot, manifest.pageId, manifest.id);
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function diffLines(baseContent: string, candidateContent: string): WikiPageDiffLine[] {
  const base = baseContent.trim().split("\n");
  const candidate = candidateContent.trim().split("\n");
  const width = candidate.length + 1;
  const cells = (base.length + 1) * width;
  if (cells > 500_000) {
    return [
      ...base.map((text, index) => ({ type: "removed" as const, text, baseLine: index + 1 })),
      ...candidate.map((text, index) => ({
        type: "added" as const,
        text,
        candidateLine: index + 1
      }))
    ];
  }
  const matrix = new Uint16Array(cells);
  for (let baseIndex = base.length - 1; baseIndex >= 0; baseIndex -= 1) {
    for (let candidateIndex = candidate.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const position = baseIndex * width + candidateIndex;
      matrix[position] =
        base[baseIndex] === candidate[candidateIndex]
          ? matrix[(baseIndex + 1) * width + candidateIndex + 1]! + 1
          : Math.max(matrix[(baseIndex + 1) * width + candidateIndex]!, matrix[position + 1]!);
    }
  }
  const diff: WikiPageDiffLine[] = [];
  let baseIndex = 0;
  let candidateIndex = 0;
  while (baseIndex < base.length || candidateIndex < candidate.length) {
    if (
      baseIndex < base.length &&
      candidateIndex < candidate.length &&
      base[baseIndex] === candidate[candidateIndex]
    ) {
      diff.push({
        type: "unchanged",
        text: base[baseIndex]!,
        baseLine: baseIndex + 1,
        candidateLine: candidateIndex + 1
      });
      baseIndex += 1;
      candidateIndex += 1;
    } else if (
      candidateIndex < candidate.length &&
      (baseIndex === base.length ||
        matrix[baseIndex * width + candidateIndex + 1]! >=
          matrix[(baseIndex + 1) * width + candidateIndex]!)
    ) {
      diff.push({
        type: "added",
        text: candidate[candidateIndex]!,
        candidateLine: candidateIndex + 1
      });
      candidateIndex += 1;
    } else {
      diff.push({ type: "removed", text: base[baseIndex]!, baseLine: baseIndex + 1 });
      baseIndex += 1;
    }
  }
  return diff;
}

async function saveWikiPageRevision(
  spaceRoot: string,
  input: {
    pageId: string;
    action: WikiPageRevisionSummary["action"];
    actorUserId: string;
    createdAt: string;
    serialized: string;
  }
): Promise<WikiPageRevisionSummary> {
  const digest = sha256(input.serialized);
  const id = `revision-${sha256(`${input.pageId}:${input.action}:${input.actorUserId}:${input.createdAt}:${digest}`).slice(0, 24)}`;
  const revision = wikiPageRevisionSummarySchema.parse({
    id,
    pageId: input.pageId,
    action: input.action,
    actorUserId: input.actorUserId,
    createdAt: input.createdAt,
    digest
  });
  const directory = revisionRoot(spaceRoot, input.pageId);
  await mkdir(directory, { recursive: true });
  await writeIfMissing(path.join(directory, `${id}.md`), input.serialized);
  await writeIfMissing(
    path.join(directory, `${id}.json`),
    `${JSON.stringify(revision, null, 2)}\n`
  );
  return revision;
}

interface WikiPageDraft extends CompiledWikiPage {
  title: string;
  nodes: CompiledNode[];
  body: string;
  related: string[];
}

function nodeTags(nodes: CompiledNode[]): string[] {
  return [
    ...new Set(
      nodes.flatMap((node) => {
        const tags = node.metadata.tags ?? node.metadata.legacyTags;
        return Array.isArray(tags)
          ? tags.filter((tag): tag is string => typeof tag === "string")
          : [];
      })
    )
  ];
}

function nodesWithSources(nodes: CompiledNode[]): string {
  return nodes
    .map((node) => {
      const title = node.title ?? node.id;
      const content = node.kind === "heading" && node.content.trim() === title ? "" : node.content;
      return `## ${title}${content.trim() ? `\n\n${content.trim()}` : ""}\n\n> 来源：${locatorRef(node.locator)}`;
    })
    .join("\n\n");
}

function stableNodeToken(node: CompiledNode): string {
  return (
    node.id
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-|-$/g, "") || "part"
  );
}

const MAX_TOPIC_NODES = 8;
const MAX_TOPIC_CHARACTERS = 6_000;

interface KnowledgeSection {
  nodes: CompiledNode[];
  anchor: CompiledNode;
  headingTitle?: string;
  part: number;
}

function isSectionHeading(node: CompiledNode): boolean {
  const level = node.metadata.level;
  return node.kind === "heading" && typeof level === "number" && level <= 2;
}

/**
 * Split on level 1/2 headings, but do not let a single headed chapter grow
 * into another document-sized page. Continuation pages retain the heading as
 * their stable identity/title context without duplicating its source locator.
 */
function knowledgeSections(nodes: CompiledNode[]): KnowledgeSection[] {
  const sections: KnowledgeSection[] = [];
  let current: CompiledNode[] = [];
  let characters = 0;
  let headingContext: { anchor: CompiledNode; title: string; part: number } | null = null;

  const flush = () => {
    if (current.length === 0) return;
    sections.push({
      nodes: current,
      anchor: headingContext?.anchor ?? current[0]!,
      ...(headingContext
        ? { headingTitle: headingContext.title, part: headingContext.part }
        : { part: 1 })
    });
    current = [];
    characters = 0;
  };

  for (const node of nodes) {
    if (isSectionHeading(node)) {
      flush();
      headingContext = {
        anchor: node,
        title: node.title ?? (node.content.trim() || node.id),
        part: 1
      };
      current.push(node);
      characters += node.content.length;
      continue;
    }

    const exceedsBudget =
      current.length > 0 &&
      (current.length >= MAX_TOPIC_NODES ||
        characters + node.content.length > MAX_TOPIC_CHARACTERS);
    if (exceedsBudget) {
      flush();
      if (headingContext) headingContext.part += 1;
    }
    current.push(node);
    characters += node.content.length;
  }
  flush();
  return sections;
}

function buildPageDrafts(input: CompileWikiInput): WikiPageDraft[] {
  const materialId = `material-${input.resourceVersionId}`;
  const baseName = `${slug(input.resourceName)}-${input.resourceVersionId.slice(0, 8)}`;

  if (input.profile === "reference") {
    return [
      {
        pageId: materialId,
        pagePath: path.join("materials", `${baseName}.md`),
        type: "material",
        title: input.resourceName,
        nodes: input.nodes,
        body: `# ${input.resourceName}\n\n${nodesWithSources(input.nodes)}`,
        related: []
      }
    ];
  }

  if (input.profile === "case") {
    return [
      {
        pageId: `case-${input.resourceVersionId}`,
        pagePath: path.join("cases", `${baseName}.md`),
        type: "case",
        title: input.resourceName,
        nodes: input.nodes,
        body: `# ${input.resourceName}\n\n> 本页按案例模式整理，仅保留源材料结构；未从缺失证据中补写背景、行动或结果。\n\n## 案例材料\n\n${nodesWithSources(input.nodes)}`,
        related: []
      }
    ];
  }

  const sections = knowledgeSections(input.nodes);
  const topics = sections.map(({ nodes, anchor, headingTitle, part }, index): WikiPageDraft => {
    const title = headingTitle
      ? part === 1
        ? headingTitle
        : `${headingTitle} · 第 ${String(part).padStart(2, "0")} 节`
      : `${input.resourceName} · 第 ${String(index + 1).padStart(2, "0")} 部分`;
    const continuation = headingTitle && part > 1 ? `-part-${String(part).padStart(2, "0")}` : "";
    return {
      pageId: `topic-${input.resourceVersionId}-${stableNodeToken(anchor)}${continuation}`,
      pagePath: path.join("topics", `${baseName}-${String(index + 1).padStart(2, "0")}.md`),
      type: "topic",
      title,
      nodes,
      body: `# ${title}\n\n${nodesWithSources(nodes)}`,
      related: [materialId]
    };
  });
  return [
    {
      pageId: materialId,
      pagePath: path.join("materials", `${baseName}.md`),
      type: "material",
      title: input.resourceName,
      nodes: input.nodes,
      body: `# ${input.resourceName}\n\n> 该页是原资料的 Wiki 索引。原文件、版本和处理任务请在“资料库”管理。\n\n## 已拆分知识\n\n${topics.map((topic) => `- ${topic.title}`).join("\n")}`,
      related: topics.map(({ pageId }) => pageId)
    },
    ...topics
  ];
}

async function createWikiPageChangeProposal(
  spaceRoot: string,
  input: {
    pageId: string;
    base: { metadata: WikiPageFrontmatter; content: string };
    candidateSerialized: string;
    nodes: CompiledNode[];
    createdAt: string;
  }
): Promise<WikiPageChangeProposalSummary | null> {
  const candidate = matter(input.candidateSerialized);
  const candidateMetadata = wikiPageFrontmatterSchema.parse(candidate.data);
  const baseDigest = semanticPageDigest(input.base.metadata, input.base.content);
  const candidateDigest = semanticPageDigest(candidateMetadata, candidate.content);
  if (baseDigest === candidateDigest) return null;

  const id = `proposal-${sha256(`${input.pageId}:${baseDigest}:${candidateDigest}`).slice(0, 24)}`;
  const existing = await readProposalManifest(spaceRoot, input.pageId, id);
  if (existing) return proposalSummary(existing);

  const baseSerialized = serialize(input.base.metadata, input.base.content);
  const diff = diffLines(input.base.content, candidate.content);
  const manifest: WikiProposalManifest = {
    schemaVersion: 1,
    id,
    pageId: input.pageId,
    status: "pending",
    createdAt: input.createdAt,
    baseDigest,
    candidateDigest,
    changedLineCount: diff.filter((line) => line.type !== "unchanged").length,
    sourceCount: candidateMetadata.sourceRefs.length,
    sourceMappings: input.nodes.map((node) => ({ nodeId: node.id, locator: node.locator }))
  };
  const directory = proposalRoot(spaceRoot, input.pageId, id);
  const staging = `${directory}.staging-${randomUUID()}`;
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(path.join(staging, "base.md"), baseSerialized);
    await writeFile(path.join(staging, "candidate.md"), input.candidateSerialized);
    await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await mkdir(path.dirname(directory), { recursive: true });
    await rename(staging, directory).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      await rm(staging, { recursive: true, force: true });
    });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return proposalSummary(manifest);
}

export async function compileWiki(
  spaceRoot: string,
  input: CompileWikiInput
): Promise<{
  pages: CompiledWikiPage[];
  reviewLockedPageIds: string[];
  changeProposals: WikiPageChangeProposalSummary[];
}> {
  const document = compiledDocumentSchema.parse({
    schemaVersion: 1,
    resourceVersionId: input.resourceVersionId,
    nodes: input.nodes
  });
  const nodes = document.nodes;

  const wikiRoot = path.join(spaceRoot, "wiki");
  const staging = path.join(spaceRoot, `.wiki-staging-${randomUUID()}`);
  await copyDirectory(wikiRoot, staging);
  const compiledAt = (input.compiledAt ?? new Date()).toISOString();
  const drafts = buildPageDrafts({ ...input, nodes });
  const reviewLockedPageIds: string[] = [];
  const lockedChanges: Array<{
    pageId: string;
    base: { metadata: WikiPageFrontmatter; content: string };
    candidateSerialized: string;
    nodes: CompiledNode[];
  }> = [];
  const publishedDrafts: WikiPageDraft[] = [];
  for (const draft of drafts) {
    const frontmatter: WikiPageFrontmatter = {
      schemaVersion: 1,
      id: draft.pageId,
      title: draft.title,
      type: draft.type,
      status: "draft",
      aliases: [],
      tags: nodeTags(draft.nodes),
      sourceRefs: [...new Set(draft.nodes.map((node) => locatorRef(node.locator)))],
      related: draft.related,
      sourceMarking: "extracted",
      compileProfile: input.profile,
      humanVerified: false,
      lastCompiled: compiledAt
    };
    const existing = await findWikiPageFile(staging, draft.pageId);
    if (
      (existing?.metadata.status === "reviewed" && existing.metadata.humanVerified) ||
      existing?.metadata.status === "conflicted"
    ) {
      reviewLockedPageIds.push(draft.pageId);
      if (existing.metadata.status === "reviewed")
        lockedChanges.push({
          pageId: draft.pageId,
          base: { metadata: existing.metadata, content: existing.content },
          candidateSerialized: serialize(frontmatter, draft.body),
          nodes: draft.nodes
        });
      continue;
    }
    await mkdir(path.dirname(path.join(staging, draft.pagePath)), { recursive: true });
    await writeFile(path.join(staging, draft.pagePath), serialize(frontmatter, draft.body));
    publishedDrafts.push(draft);
  }
  await rebuildIndex(staging);

  const issues = await lintWikiDirectory(staging);
  if (issues.length > 0) {
    await rm(staging, { recursive: true, force: true });
    throw new Error(
      `WIKI_LINT_FAILED: ${issues.map((issue) => `${issue.file}:${issue.code}`).join(", ")}`
    );
  }

  await publishWikiDirectory(spaceRoot, staging, "compile");
  await writeFile(
    path.join(wikiRoot, "log.md"),
    `\n- ${compiledAt} compiled ${drafts.map(({ pageId }) => pageId).join(", ")} from ${input.resourceVersionId} as ${input.profile}\n`,
    { flag: "a" }
  );
  const mappingLines = publishedDrafts.flatMap((draft) =>
    draft.nodes.map((node) =>
      JSON.stringify({ pageId: draft.pageId, nodeId: node.id, locator: node.locator })
    )
  );
  if (mappingLines.length > 0)
    await writeFile(
      path.join(spaceRoot, "mappings", "source-map.jsonl"),
      `${mappingLines.join("\n")}\n`,
      {
        flag: "a"
      }
    );
  const changeProposals = (
    await Promise.all(
      lockedChanges.map((change) =>
        createWikiPageChangeProposal(spaceRoot, { ...change, createdAt: compiledAt })
      )
    )
  ).filter((proposal): proposal is WikiPageChangeProposalSummary => proposal !== null);
  return {
    pages: drafts.map(({ pageId, pagePath, type }) => ({ pageId, pagePath, type })),
    reviewLockedPageIds,
    changeProposals
  };
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else await writeFile(to, await readFile(from));
  }
}

async function wikiFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await wikiFiles(full)));
    else if (entry.name.endsWith(".md") && entry.name !== "index.md" && entry.name !== "log.md")
      result.push(full);
  }
  return result;
}

async function findWikiPageFile(
  wikiRoot: string,
  pageId: string
): Promise<{ file: string; content: string; metadata: WikiPageFrontmatter } | null> {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(pageId)) return null;
  for (const file of await wikiFiles(wikiRoot)) {
    const parsed = matter(await readFile(file, "utf8"));
    const metadata = wikiPageFrontmatterSchema.parse(parsed.data);
    if (metadata.id === pageId) return { file, content: parsed.content, metadata };
  }
  return null;
}

async function publishWikiDirectory(
  spaceRoot: string,
  staging: string,
  operation: "compile" | "review" | "conflict" | "proposal" | "migration" = "compile"
): Promise<void> {
  await writeCurrentWikiSchemaManifest(
    staging,
    operation === "migration" ? "migration" : "publish"
  );
  const pages = await Promise.all(
    (await wikiFiles(staging)).map(async (file) => ({
      path: path.relative(staging, file).replaceAll(path.sep, "/"),
      sha256: sha256(await readFile(file, "utf8"))
    }))
  );
  await writeFile(
    path.join(staging, "publish-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        publishId: randomUUID(),
        operation,
        status: "published",
        publishedAt: new Date().toISOString(),
        pages
      },
      null,
      2
    )}\n`
  );
  const wikiRoot = path.join(spaceRoot, "wiki");
  const backup = path.join(spaceRoot, `.wiki-backup-${randomUUID()}`);
  await rename(wikiRoot, backup);
  try {
    await rename(staging, wikiRoot);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rename(backup, wikiRoot).catch(() => undefined);
    throw error;
  }
}

export async function migrateWikiSchemaManifest(
  spaceRoot: string,
  options: { quiesced: boolean }
): Promise<WikiSchemaMigrationResult> {
  if (!options.quiesced) throw new Error("WIKI_SCHEMA_MIGRATION_QUIESCED_REQUIRED");
  const wikiRoot = path.join(spaceRoot, "wiki");
  const inspection = await inspectWikiSchema(wikiRoot);
  if (inspection.status === "invalid") throw new Error("WIKI_SCHEMA_INVALID");
  if (inspection.status === "current") {
    return { status: "already_current", wikiSchemaVersion: CURRENT_WIKI_SCHEMA_VERSION };
  }

  const staging = path.join(spaceRoot, `.wiki-staging-${randomUUID()}`);
  await copyDirectory(wikiRoot, staging);
  try {
    await writeCurrentWikiSchemaManifest(staging, "migration");
    const issues = await lintWikiDirectory(staging);
    if (issues.length > 0) throw new Error("WIKI_SCHEMA_LINT_FAILED");
    await publishWikiDirectory(spaceRoot, staging, "migration");
    return { status: "migrated", wikiSchemaVersion: CURRENT_WIKI_SCHEMA_VERSION };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export {
  CURRENT_WIKI_SCHEMA_VERSION,
  inspectWikiSchema,
  WIKI_SCHEMA_MANIFEST_FILE,
  writeCurrentWikiSchemaManifest
} from "./schema-lifecycle";

function pageExcerpt(content: string): string {
  return content
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s*来源：.*$/gm, "")
    .replace(/[`*_>[\]()~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function pageSummary(metadata: WikiPageFrontmatter, content: string): WikiPageSummary {
  return {
    id: metadata.id,
    title: metadata.title,
    type: metadata.type,
    status: metadata.status,
    aliases: metadata.aliases,
    tags: metadata.tags,
    sourceMarking: metadata.sourceMarking,
    humanVerified: metadata.humanVerified,
    conflictIds: metadata.conflictIds ?? [],
    ...(metadata.reviewedAt ? { reviewedAt: metadata.reviewedAt } : {}),
    ...(metadata.reviewedBy ? { reviewedBy: metadata.reviewedBy } : {}),
    lastCompiled: metadata.lastCompiled,
    sourceCount: metadata.sourceRefs.length,
    excerpt: pageExcerpt(content)
  };
}

function pageDetail(metadata: WikiPageFrontmatter, content: string): WikiPageDetail {
  return {
    ...pageSummary(metadata, content),
    content: content.trim(),
    sourceRefs: metadata.sourceRefs,
    related: metadata.related
  };
}

export async function listWikiPages(
  spaceRoot: string,
  filters: WikiPageListQuery = {}
): Promise<WikiPageSummary[]> {
  const wikiRoot = path.join(spaceRoot, "wiki");
  await readFile(path.join(wikiRoot, "index.md"), "utf8");
  const search = filters.search?.normalize("NFKC").toLowerCase();
  const pages: WikiPageSummary[] = [];

  for (const file of await wikiFiles(wikiRoot)) {
    const parsed = matter(await readFile(file, "utf8"));
    const metadata = wikiPageFrontmatterSchema.parse(parsed.data);
    if (!filters.status && metadata.status === "deprecated") continue;
    if (filters.status && metadata.status !== filters.status) continue;
    if (filters.type && metadata.type !== filters.type) continue;
    if (filters.types && !filters.types.includes(metadata.type)) continue;
    if (search) {
      const haystack = [metadata.title, ...metadata.aliases, ...metadata.tags, parsed.content]
        .join("\n")
        .normalize("NFKC")
        .toLowerCase();
      if (!haystack.includes(search)) continue;
    }
    pages.push(pageSummary(metadata, parsed.content));
  }

  return pages.sort(
    (left, right) =>
      Date.parse(right.lastCompiled) - Date.parse(left.lastCompiled) ||
      left.title.localeCompare(right.title, "zh-CN")
  );
}

export async function getWikiPage(
  spaceRoot: string,
  pageId: string
): Promise<WikiPageDetail | null> {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(pageId)) return null;
  const wikiRoot = path.join(spaceRoot, "wiki");
  await readFile(path.join(wikiRoot, "index.md"), "utf8");
  for (const file of await wikiFiles(wikiRoot)) {
    const parsed = matter(await readFile(file, "utf8"));
    const metadata = wikiPageFrontmatterSchema.parse(parsed.data);
    if (metadata.id !== pageId) continue;
    return pageDetail(metadata, parsed.content);
  }
  return null;
}

export async function listWikiConflicts(spaceRoot: string): Promise<WikiConflictSummary[]> {
  const directory = conflictRoot(spaceRoot);
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  );
  const manifests = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && /^conflict-[a-f0-9]{24}$/.test(entry.name))
        .map((entry) => readWikiConflictManifest(spaceRoot, entry.name))
    )
  ).filter((manifest): manifest is WikiConflictManifest => manifest !== null);
  return manifests
    .map(conflictSummary)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export async function getWikiConflict(
  spaceRoot: string,
  conflictId: string
): Promise<WikiConflictDetail | null> {
  const manifest = await readWikiConflictManifest(spaceRoot, conflictId);
  if (!manifest) return null;
  const directory = conflictRoot(spaceRoot, conflictId);
  const [leftSerialized, rightSerialized] = await Promise.all([
    readFile(path.join(directory, "left.md"), "utf8"),
    readFile(path.join(directory, "right.md"), "utf8")
  ]);
  const left = matter(leftSerialized);
  const right = matter(rightSerialized);
  const leftMetadata = wikiPageFrontmatterSchema.parse(left.data);
  const rightMetadata = wikiPageFrontmatterSchema.parse(right.data);
  if (leftMetadata.id !== manifest.leftPageId || rightMetadata.id !== manifest.rightPageId)
    throw new Error("WIKI_CONFLICT_INVALID");
  return {
    ...conflictSummary(manifest),
    left: pageDetail(leftMetadata, left.content),
    right: pageDetail(rightMetadata, right.content)
  };
}

function conflictPageMetadata(
  metadata: WikiPageFrontmatter,
  conflictId: string
): WikiPageFrontmatter {
  return wikiPageFrontmatterSchema.parse({
    ...metadata,
    status: "conflicted",
    humanVerified: false,
    reviewedAt: undefined,
    reviewedBy: undefined,
    conflictIds: [...new Set([...(metadata.conflictIds ?? []), conflictId])]
  });
}

async function publishConflictPages(
  spaceRoot: string,
  updates: Array<{ pageId: string; metadata: WikiPageFrontmatter; content: string }>
): Promise<void> {
  const wikiRoot = path.join(spaceRoot, "wiki");
  const staging = path.join(spaceRoot, `.wiki-staging-${randomUUID()}`);
  await copyDirectory(wikiRoot, staging);
  try {
    for (const update of updates) {
      const page = await findWikiPageFile(staging, update.pageId);
      if (!page) throw new Error("WIKI_PAGE_NOT_FOUND");
      await writeFile(page.file, serialize(update.metadata, update.content));
    }
    await rebuildIndex(staging);
    const issues = await lintWikiDirectory(staging);
    if (issues.length > 0)
      throw new Error(
        `WIKI_LINT_FAILED: ${issues.map((issue) => `${issue.file}:${issue.code}`).join(", ")}`
      );
    await publishWikiDirectory(spaceRoot, staging, "conflict");
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function declareWikiConflict(
  spaceRoot: string,
  input: DeclareWikiConflictInput
): Promise<WikiConflictDetail> {
  if (input.leftPageId === input.rightPageId) throw new Error("WIKI_CONFLICT_PAGES_MUST_DIFFER");
  const wikiRoot = path.join(spaceRoot, "wiki");
  const [left, right, conflicts] = await Promise.all([
    findWikiPageFile(wikiRoot, input.leftPageId),
    findWikiPageFile(wikiRoot, input.rightPageId),
    listWikiConflicts(spaceRoot)
  ]);
  if (!left || !right) throw new Error("WIKI_PAGE_NOT_FOUND");
  if (left.metadata.sourceRefs.length === 0 || right.metadata.sourceRefs.length === 0)
    throw new Error("WIKI_CONFLICT_SOURCE_REQUIRED");
  if (
    conflicts.some(
      (conflict) =>
        conflict.status !== "resolved" &&
        ((conflict.leftPageId === input.leftPageId && conflict.rightPageId === input.rightPageId) ||
          (conflict.leftPageId === input.rightPageId && conflict.rightPageId === input.leftPageId))
    )
  )
    throw new Error("WIKI_CONFLICT_ALREADY_OPEN");
  const createdAt = (input.createdAt ?? new Date()).toISOString();
  const pair = [input.leftPageId, input.rightPageId].sort().join(":");
  const id = `conflict-${sha256(`${pair}:${semanticPageDigest(left.metadata, left.content)}:${semanticPageDigest(right.metadata, right.content)}:${createdAt}`).slice(0, 24)}`;
  const manifest: WikiConflictManifest = {
    schemaVersion: 1,
    id,
    status: "open",
    leftPageId: input.leftPageId,
    rightPageId: input.rightPageId,
    createdAt,
    createdBy: input.actorUserId
  };
  const directory = conflictRoot(spaceRoot, id);
  const staging = `${directory}.staging-${randomUUID()}`;
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(path.join(staging, "left.md"), serialize(left.metadata, left.content));
    await writeFile(path.join(staging, "right.md"), serialize(right.metadata, right.content));
    await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(staging, directory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  try {
    await publishConflictPages(spaceRoot, [
      {
        pageId: input.leftPageId,
        metadata: conflictPageMetadata(left.metadata, id),
        content: left.content
      },
      {
        pageId: input.rightPageId,
        metadata: conflictPageMetadata(right.metadata, id),
        content: right.content
      }
    ]);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  await writeFile(
    path.join(wikiRoot, "log.md"),
    `\n- ${createdAt} declared conflict ${id} between ${input.leftPageId} and ${input.rightPageId} by ${input.actorUserId}\n`,
    { flag: "a" }
  );
  const conflict = await getWikiConflict(spaceRoot, id);
  if (!conflict) throw new Error("WIKI_CONFLICT_NOT_FOUND");
  return conflict;
}

export async function decideWikiConflict(
  spaceRoot: string,
  input: DecideWikiConflictInput
): Promise<WikiConflictDetail> {
  const manifest = await readWikiConflictManifest(spaceRoot, input.conflictId);
  if (!manifest) throw new Error("WIKI_CONFLICT_NOT_FOUND");
  if (manifest.status === "resolved") throw new Error("WIKI_CONFLICT_STATE_INVALID");
  const wikiRoot = path.join(spaceRoot, "wiki");
  const [left, right] = await Promise.all([
    findWikiPageFile(wikiRoot, manifest.leftPageId),
    findWikiPageFile(wikiRoot, manifest.rightPageId)
  ]);
  if (!left || !right) throw new Error("WIKI_PAGE_NOT_FOUND");
  if (left.metadata.status !== "conflicted" || right.metadata.status !== "conflicted")
    throw new Error("WIKI_CONFLICT_STATE_INVALID");
  const decidedAt = (input.decidedAt ?? new Date()).toISOString();
  if (input.action !== "keep_parallel") {
    const winner = input.action === "select_left" ? left : right;
    const loser = input.action === "select_left" ? right : left;
    const winnerMetadata = wikiPageFrontmatterSchema.parse({
      ...winner.metadata,
      status: "reviewed",
      humanVerified: true,
      reviewedAt: decidedAt,
      reviewedBy: input.actorUserId
    });
    const loserMetadata = wikiPageFrontmatterSchema.parse({
      ...loser.metadata,
      status: "deprecated",
      humanVerified: false,
      reviewedAt: undefined,
      reviewedBy: undefined
    });
    await publishConflictPages(spaceRoot, [
      { pageId: winner.metadata.id, metadata: winnerMetadata, content: winner.content },
      { pageId: loser.metadata.id, metadata: loserMetadata, content: loser.content }
    ]);
  }
  const updated: WikiConflictManifest = {
    ...manifest,
    status: input.action === "keep_parallel" ? "parallel" : "resolved",
    resolvedAt: decidedAt,
    resolvedBy: input.actorUserId,
    resolution: input.action
  };
  await writeWikiConflictManifest(spaceRoot, updated);
  await writeFile(
    path.join(wikiRoot, "log.md"),
    `\n- ${decidedAt} ${input.action} conflict ${input.conflictId} by ${input.actorUserId}\n`,
    { flag: "a" }
  );
  const conflict = await getWikiConflict(spaceRoot, input.conflictId);
  if (!conflict) throw new Error("WIKI_CONFLICT_NOT_FOUND");
  return conflict;
}

export async function listWikiPageChangeProposals(
  spaceRoot: string,
  pageId: string
): Promise<WikiPageChangeProposalSummary[]> {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(pageId)) return [];
  const directory = path.join(reviewPageRoot(spaceRoot, pageId), "proposals");
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  );
  const proposals = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && /^proposal-[a-f0-9]{24}$/.test(entry.name))
        .map((entry) => readProposalManifest(spaceRoot, pageId, entry.name))
    )
  ).filter((proposal): proposal is WikiProposalManifest => proposal !== null);
  return proposals
    .map(proposalSummary)
    .sort(
      (left, right) =>
        Number(left.status !== "pending") - Number(right.status !== "pending") ||
        Date.parse(right.createdAt) - Date.parse(left.createdAt)
    );
}

export async function listWikiPageRevisions(
  spaceRoot: string,
  pageId: string
): Promise<WikiPageRevisionSummary[]> {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(pageId)) return [];
  const directory = revisionRoot(spaceRoot, pageId);
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  );
  const revisions = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /^revision-[a-f0-9]{24}\.json$/.test(entry.name))
      .map(async (entry) =>
        wikiPageRevisionSummarySchema.parse(
          JSON.parse(await readFile(path.join(directory, entry.name), "utf8"))
        )
      )
  );
  return revisions.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export async function getWikiPageChangeProposal(
  spaceRoot: string,
  pageId: string,
  proposalId: string
): Promise<WikiPageChangeProposalDetail | null> {
  const manifest = await readProposalManifest(spaceRoot, pageId, proposalId);
  if (!manifest) return null;
  const directory = proposalRoot(spaceRoot, pageId, proposalId);
  const [baseSerialized, candidateSerialized] = await Promise.all([
    readFile(path.join(directory, "base.md"), "utf8"),
    readFile(path.join(directory, "candidate.md"), "utf8")
  ]);
  const base = matter(baseSerialized);
  const candidate = matter(candidateSerialized);
  const baseMetadata = wikiPageFrontmatterSchema.parse(base.data);
  const candidateMetadata = wikiPageFrontmatterSchema.parse(candidate.data);
  if (
    baseMetadata.id !== pageId ||
    candidateMetadata.id !== pageId ||
    semanticPageDigest(baseMetadata, base.content) !== manifest.baseDigest ||
    semanticPageDigest(candidateMetadata, candidate.content) !== manifest.candidateDigest
  )
    throw new Error("WIKI_PROPOSAL_INVALID");
  return {
    ...proposalSummary(manifest),
    base: { digest: manifest.baseDigest, content: base.content.trim() },
    candidate: { digest: manifest.candidateDigest, content: candidate.content.trim() },
    diff: diffLines(base.content, candidate.content)
  };
}

export async function decideWikiPageProposal(
  spaceRoot: string,
  input: DecideWikiPageProposalInput
): Promise<WikiProposalDecisionResult> {
  const manifest = await readProposalManifest(spaceRoot, input.pageId, input.proposalId);
  if (!manifest) throw new Error("WIKI_PROPOSAL_NOT_FOUND");
  if (manifest.status !== "pending") throw new Error("WIKI_PROPOSAL_STATE_INVALID");
  const wikiRoot = path.join(spaceRoot, "wiki");
  const current = await findWikiPageFile(wikiRoot, input.pageId);
  if (!current) throw new Error("WIKI_PAGE_NOT_FOUND");
  const decisionAt = (input.reviewedAt ?? new Date()).toISOString();
  if (semanticPageDigest(current.metadata, current.content) !== manifest.baseDigest) {
    await writeProposalManifest(spaceRoot, {
      ...manifest,
      status: "stale",
      resolvedAt: decisionAt,
      resolvedBy: input.reviewerId
    });
    throw new Error("WIKI_PROPOSAL_BASE_STALE");
  }

  if (input.action === "reject") {
    const proposal = proposalSummary({
      ...manifest,
      status: "rejected",
      resolvedAt: decisionAt,
      resolvedBy: input.reviewerId
    });
    await writeProposalManifest(spaceRoot, { ...manifest, ...proposal });
    const page = await getWikiPage(spaceRoot, input.pageId);
    if (!page) throw new Error("WIKI_PAGE_NOT_FOUND");
    await writeFile(
      path.join(wikiRoot, "log.md"),
      `\n- ${decisionAt} rejected proposal ${input.proposalId} for ${input.pageId} by ${input.reviewerId}\n`,
      { flag: "a" }
    );
    return { page, proposal };
  }

  const directory = proposalRoot(spaceRoot, input.pageId, input.proposalId);
  const candidate = matter(await readFile(path.join(directory, "candidate.md"), "utf8"));
  const candidateMetadata = wikiPageFrontmatterSchema.parse(candidate.data);
  if (candidateMetadata.id !== input.pageId) throw new Error("WIKI_PROPOSAL_INVALID");
  const reviewedCandidate = wikiPageFrontmatterSchema.parse({
    ...candidateMetadata,
    status: "reviewed",
    humanVerified: true,
    reviewedAt: decisionAt,
    reviewedBy: input.reviewerId
  });
  const staging = path.join(spaceRoot, `.wiki-staging-${randomUUID()}`);
  await copyDirectory(wikiRoot, staging);
  try {
    const stagedCurrent = await findWikiPageFile(staging, input.pageId);
    if (!stagedCurrent) throw new Error("WIKI_PAGE_NOT_FOUND");
    await writeFile(stagedCurrent.file, serialize(reviewedCandidate, candidate.content));
    await rebuildIndex(staging);
    const issues = await lintWikiDirectory(staging);
    if (issues.length > 0)
      throw new Error(
        `WIKI_LINT_FAILED: ${issues.map((issue) => `${issue.file}:${issue.code}`).join(", ")}`
      );
    await publishWikiDirectory(spaceRoot, staging, "proposal");
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  const previousSerialized = serialize(current.metadata, current.content);
  const acceptedSerialized = serialize(reviewedCandidate, candidate.content);
  await saveWikiPageRevision(spaceRoot, {
    pageId: input.pageId,
    action: "proposal_accepted",
    actorUserId: input.reviewerId,
    createdAt: decisionAt,
    serialized: previousSerialized
  });
  await saveWikiPageRevision(spaceRoot, {
    pageId: input.pageId,
    action: "proposal_accepted",
    actorUserId: input.reviewerId,
    createdAt: new Date(Date.parse(decisionAt) + 1).toISOString(),
    serialized: acceptedSerialized
  });
  const proposal = proposalSummary({
    ...manifest,
    status: "accepted",
    resolvedAt: decisionAt,
    resolvedBy: input.reviewerId
  });
  await writeProposalManifest(spaceRoot, { ...manifest, ...proposal });
  if (manifest.sourceMappings.length > 0)
    await writeFile(
      path.join(spaceRoot, "mappings", "source-map.jsonl"),
      `${manifest.sourceMappings.map((mapping) => JSON.stringify({ pageId: input.pageId, ...mapping })).join("\n")}\n`,
      { flag: "a" }
    );
  await writeFile(
    path.join(wikiRoot, "log.md"),
    `\n- ${decisionAt} accepted proposal ${input.proposalId} for ${input.pageId} by ${input.reviewerId}\n`,
    { flag: "a" }
  );
  const page = await getWikiPage(spaceRoot, input.pageId);
  if (!page) throw new Error("WIKI_PAGE_NOT_FOUND");
  return { page, proposal };
}

export async function reviewWikiPage(
  spaceRoot: string,
  input: ReviewWikiPageInput
): Promise<WikiPageDetail> {
  const wikiRoot = path.join(spaceRoot, "wiki");
  const staging = path.join(spaceRoot, `.wiki-staging-${randomUUID()}`);
  await copyDirectory(wikiRoot, staging);
  try {
    const page = await findWikiPageFile(staging, input.pageId);
    if (!page) throw new Error("WIKI_PAGE_NOT_FOUND");
    if (input.action === "approve" && page.metadata.status !== "draft")
      throw new Error("WIKI_REVIEW_STATE_INVALID");
    if (input.action === "reopen" && page.metadata.status !== "reviewed")
      throw new Error("WIKI_REVIEW_STATE_INVALID");

    const metadata: WikiPageFrontmatter =
      input.action === "approve"
        ? {
            ...page.metadata,
            status: "reviewed",
            humanVerified: true,
            reviewedAt: (input.reviewedAt ?? new Date()).toISOString(),
            reviewedBy: input.reviewerId
          }
        : {
            ...page.metadata,
            status: "draft",
            humanVerified: false,
            reviewedAt: undefined,
            reviewedBy: undefined
          };
    const cleanMetadata = wikiPageFrontmatterSchema.parse(
      Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined))
    );
    await writeFile(page.file, serialize(cleanMetadata, page.content));
    await rebuildIndex(staging);
    const issues = await lintWikiDirectory(staging);
    if (issues.length > 0)
      throw new Error(
        `WIKI_LINT_FAILED: ${issues.map((issue) => `${issue.file}:${issue.code}`).join(", ")}`
      );
    await publishWikiDirectory(spaceRoot, staging, "review");
    if (input.action === "approve") {
      await saveWikiPageRevision(spaceRoot, {
        pageId: input.pageId,
        action: "approved",
        actorUserId: input.reviewerId,
        createdAt: cleanMetadata.reviewedAt!,
        serialized: serialize(cleanMetadata, page.content)
      });
    }
    await writeFile(
      path.join(wikiRoot, "log.md"),
      `\n- ${new Date().toISOString()} ${input.action} ${input.pageId} by ${input.reviewerId}\n`,
      { flag: "a" }
    );
    const updated = await getWikiPage(spaceRoot, input.pageId);
    if (!updated) throw new Error("WIKI_PAGE_NOT_FOUND");
    return updated;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function rebuildIndex(wikiRoot: string): Promise<void> {
  const lines = ["# Knowledge index", "", "查询必须先从本页路由，再读取候选页面。", ""];
  for (const file of await wikiFiles(wikiRoot)) {
    const parsed = matter(await readFile(file, "utf8"));
    const metadata = wikiPageFrontmatterSchema.parse(parsed.data);
    const relative = path.relative(wikiRoot, file).replaceAll(path.sep, "/");
    lines.push(`- [${metadata.title}](${relative}) — ${metadata.tags.join("、") || "未标记"}`);
  }
  await writeFile(path.join(wikiRoot, "index.md"), `${lines.join("\n")}\n`);
}

export async function lintWikiDirectory(wikiRoot: string): Promise<WikiLintIssue[]> {
  const issues: WikiLintIssue[] = [];
  const indexPath = path.join(wikiRoot, "index.md");
  if (
    !(await stat(indexPath).then(
      () => true,
      () => false
    ))
  ) {
    issues.push({ file: "index.md", code: "INDEX_MISSING", message: "根索引不存在" });
  }
  const ids = new Set<string>();
  for (const file of await wikiFiles(wikiRoot)) {
    const relative = path.relative(wikiRoot, file).replaceAll(path.sep, "/");
    try {
      const parsed = matter(await readFile(file, "utf8"));
      const metadata = wikiPageFrontmatterSchema.parse(parsed.data);
      if (ids.has(metadata.id))
        issues.push({ file: relative, code: "DUPLICATE_ID", message: metadata.id });
      ids.add(metadata.id);
      for (const ref of metadata.sourceRefs) parseLocatorRef(ref);
    } catch (error) {
      issues.push({
        file: relative,
        code: "SCHEMA_INVALID",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return issues;
}

const QUERY_STOP_WORDS = new Set([
  "怎样",
  "怎么",
  "如何",
  "什么",
  "哪些",
  "为什么",
  "是否",
  "可以",
  "应该",
  "进行",
  "这个",
  "那个",
  "通过",
  "关于",
  "一下",
  "以及",
  "a",
  "an",
  "and",
  "are",
  "does",
  "how",
  "in",
  "is",
  "of",
  "the",
  "to",
  "what"
]);

function queryTerms(question: string): string[] {
  const normalized = question.normalize("NFKC").toLowerCase();
  const latin = (normalized.match(/[\p{Script=Latin}\p{Number}]{2,}/gu) ?? []).filter(
    (term) => !QUERY_STOP_WORDS.has(term)
  );
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  const cjk = [...segmenter.segment(normalized)]
    .filter(({ isWordLike, segment }) => isWordLike && /^[\p{Script=Han}]+$/u.test(segment))
    .map(({ segment }) => segment)
    .filter((term) => [...term].length >= 2 && !QUERY_STOP_WORDS.has(term));
  return [...new Set([...latin, ...cjk])];
}

function termScore(text: string, terms: string[]): number {
  return terms.reduce(
    (score, term) => score + (text.includes(term) ? Math.min([...term].length, 4) : 0),
    0
  );
}

function answerExcerpt(content: string, terms: string[]): string {
  const blocks = content
    .replace(/^>\s*来源：.*$/gm, "")
    .replace(/wk:\/\/source\/\S+/g, "")
    .split(/\n{2,}/)
    .map((block) =>
      block
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((block) => block.length > 0);
  const matched = blocks
    .map((block, index) => ({ block, index, score: termScore(block.toLowerCase(), terms) }))
    .filter(({ block, score }) => score > 0 && block.length >= 12)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 2)
    .sort((left, right) => left.index - right.index)
    .map(({ block }) => block);
  return (matched.length > 0 ? matched : blocks.slice(0, 2)).join("\n\n").slice(0, 500);
}

export async function queryWiki(
  spaceRoot: string,
  question: string,
  limit = 10
): Promise<WikiQueryResult> {
  const evidence = await queryWikiEvidence(spaceRoot, question, limit);
  if (evidence.items.length === 0) {
    return {
      answer: "现有知识库中没有找到足够依据。",
      citations: [],
      searchedPages: evidence.searchedPages,
      refused: true
    };
  }
  return {
    answer: evidence.items.map(({ pageTitle, text }) => `${pageTitle}\n${text}`).join("\n\n"),
    citations: evidence.items.map((item) => ({
      pageId: item.pageId,
      title: item.pageTitle,
      sourceRefs: item.sourceRefs
    })),
    searchedPages: evidence.searchedPages,
    refused: false
  };
}

export async function queryWikiEvidence(
  spaceRoot: string,
  question: string,
  limit = 10,
  filter: WikiEvidenceFilter = {}
): Promise<EvidenceBundle> {
  const wikiRoot = path.join(spaceRoot, "wiki");
  await readFile(path.join(wikiRoot, "index.md"), "utf8");
  const terms = queryTerms(question);
  const pageIds = filter.pageIds ? new Set(filter.pageIds) : null;
  const resourceVersionIds = filter.resourceVersionIds ? new Set(filter.resourceVersionIds) : null;
  const candidates = [] as Array<{
    score: number;
    matchedTerms: number;
    metadata: WikiPageFrontmatter;
    content: string;
  }>;
  const files = await wikiFiles(wikiRoot);
  for (const file of files) {
    const parsed = matter(await readFile(file, "utf8"));
    const metadata = wikiPageFrontmatterSchema.parse(parsed.data);
    if (pageIds && !pageIds.has(metadata.id)) continue;
    if (
      resourceVersionIds &&
      !metadata.sourceRefs.some((sourceRef) => {
        try {
          return resourceVersionIds.has(parseLocatorRef(sourceRef).resourceVersionId);
        } catch {
          return false;
        }
      })
    )
      continue;
    const titleText =
      `${metadata.title} ${metadata.aliases.join(" ")} ${metadata.tags.join(" ")}`.toLowerCase();
    const bodyText = parsed.content.toLowerCase();
    const score = termScore(titleText, terms) * 5 + termScore(bodyText, terms);
    const searchable = `${titleText}\n${bodyText}`;
    const matchedTerms = terms.filter((term) => searchable.includes(term)).length;
    if (score > 0) candidates.push({ score, matchedTerms, metadata, content: parsed.content });
  }
  candidates.sort((a, b) => b.score - a.score || a.metadata.title.localeCompare(b.metadata.title));
  const minimumScore = candidates[0] ? Math.max(2, Math.ceil(candidates[0].score * 0.25)) : 0;
  const maximumMatchedTerms = candidates.reduce(
    (maximum, candidate) => Math.max(maximum, candidate.matchedTerms),
    0
  );
  const minimumMatchedTerms = Math.max(
    terms.length >= 2 ? 2 : 1,
    Math.ceil(maximumMatchedTerms * 0.66)
  );
  const eligible = candidates.filter(
    ({ score, matchedTerms }) => score >= minimumScore && matchedTerms >= minimumMatchedTerms
  );
  const semantic = eligible.filter(({ metadata }) => metadata.type !== "material");
  const selected = (semantic.length > 0 ? semantic : eligible).slice(0, limit);
  return evidenceBundleSchema.parse({
    question,
    items: selected.map(({ metadata, content }, index) => ({
      id: `evidence-${String(index + 1).padStart(2, "0")}`,
      pageId: metadata.id,
      pageTitle: metadata.title,
      pageType: metadata.type,
      text: answerExcerpt(content, terms),
      sourceRefs: metadata.sourceRefs,
      conflicted: metadata.status === "conflicted"
    })),
    searchedPages: files.length,
    embeddingCalls: 0
  });
}
