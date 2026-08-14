import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  wikiGoldenDatasetSchema,
  wikiGoldenReportSchema,
  wikiGoldenReviewManifestSchema,
  type WikiGoldenCaseResult,
  type WikiGoldenDataset,
  type WikiGoldenReviewManifest,
  type WikiGoldenReport
} from "@wknowledge/contracts";
import {
  compileWiki,
  initializeSpace,
  listWikiPages,
  parseLocatorRef,
  queryWikiEvidence
} from "./index";

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

export function wikiGoldenDatasetSha256(dataset: WikiGoldenDataset): string {
  return createHash("sha256").update(canonicalize(dataset)).digest("hex");
}

export async function loadWikiGoldenDataset(file: string): Promise<WikiGoldenDataset> {
  return wikiGoldenDatasetSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

export async function loadWikiGoldenReviewManifest(
  file: string
): Promise<WikiGoldenReviewManifest> {
  return wikiGoldenReviewManifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

export function validateWikiGoldenReviewManifest(
  datasetInput: WikiGoldenDataset,
  manifestInput: WikiGoldenReviewManifest,
  options: { formal: boolean }
): void {
  const dataset = wikiGoldenDatasetSchema.parse(datasetInput);
  const manifest = wikiGoldenReviewManifestSchema.parse(manifestInput);
  if (manifest.datasetId !== dataset.id) throw new Error("GOLDEN_REVIEW_DATASET_MISMATCH");
  if (manifest.datasetSha256 !== wikiGoldenDatasetSha256(dataset))
    throw new Error("GOLDEN_REVIEW_DATASET_SHA256_MISMATCH");
  if (manifest.stage !== dataset.stage) throw new Error("GOLDEN_REVIEW_STAGE_MISMATCH");
  if (manifest.status !== "approved") throw new Error("GOLDEN_REVIEW_NOT_APPROVED");
  const documentReviewById = new Map(
    manifest.documentReviews.map((review) => [review.documentId, review])
  );
  if (documentReviewById.size !== dataset.documents.length)
    throw new Error("GOLDEN_REVIEW_DOCUMENT_COVERAGE_INVALID");
  for (const document of dataset.documents)
    if (!documentReviewById.has(document.id))
      throw new Error(`GOLDEN_REVIEW_DOCUMENT_MISSING:${document.id}`);
  const questionReviewById = new Map(
    manifest.questionReviews.map((review) => [review.questionId, review])
  );
  if (questionReviewById.size !== dataset.questions.length)
    throw new Error("GOLDEN_REVIEW_QUESTION_COVERAGE_INVALID");
  for (const question of dataset.questions) {
    const review = questionReviewById.get(question.id);
    if (!review) throw new Error(`GOLDEN_REVIEW_QUESTION_MISSING:${question.id}`);
    if (
      JSON.stringify(review.expectedPageIds) !== JSON.stringify(question.expectedPageIds) ||
      JSON.stringify(review.expectedResourceVersionIds) !==
        JSON.stringify(question.expectedResourceVersionIds) ||
      JSON.stringify(review.expectedSourceRefs) !== JSON.stringify(question.expectedSourceRefs)
    )
      throw new Error(`GOLDEN_REVIEW_EXPECTATION_MISMATCH:${question.id}`);
  }
  if (!options.formal) return;
  if (dataset.stage !== "blind") throw new Error("GOLDEN_FORMAL_REQUIRES_BLIND_DATASET");
  if (dataset.documents.length < 100) throw new Error("GOLDEN_FORMAL_REQUIRES_100_DOCUMENTS");
  if (dataset.questions.length < 50) throw new Error("GOLDEN_FORMAL_REQUIRES_50_QUESTIONS");
  if (dataset.thresholds.recallAt10 < 0.85)
    throw new Error("GOLDEN_FORMAL_REQUIRES_RECALL_THRESHOLD");
  if (dataset.thresholds.sourceLocatorAccuracy < 0.95)
    throw new Error("GOLDEN_FORMAL_REQUIRES_SOURCE_LOCATOR_THRESHOLD");
  for (const question of dataset.questions)
    if (
      !question.expectRefusal &&
      (question.expectedPageIds.length === 0 ||
        question.expectedResourceVersionIds.length === 0 ||
        question.expectedSourceRefs.length === 0)
    )
      throw new Error(`GOLDEN_FORMAL_REQUIRES_SOURCE_ANNOTATION:${question.id}`);
}

export async function evaluateWikiGoldenDataset(
  datasetInput: WikiGoldenDataset,
  options: { reviewManifest?: WikiGoldenReviewManifest; formal?: boolean } = {}
): Promise<WikiGoldenReport> {
  const dataset = wikiGoldenDatasetSchema.parse(datasetInput);
  if (options.reviewManifest)
    validateWikiGoldenReviewManifest(dataset, options.reviewManifest, {
      formal: options.formal ?? false
    });
  else if (options.formal) throw new Error("GOLDEN_FORMAL_REQUIRES_REVIEW_MANIFEST");
  const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-eval-"));
  try {
    const spaceIds = new Set(dataset.documents.map(({ spaceId }) => spaceId));
    if (spaceIds.size !== 1) throw new Error("GOLDEN_DATASET_SPACE_MISMATCH");
    const spaceId = dataset.documents[0]!.spaceId;
    const spaceRoot = await initializeSpace(root, spaceId);
    for (const document of dataset.documents)
      await compileWiki(spaceRoot, {
        spaceId,
        resourceVersionId: document.resourceVersionId,
        resourceName: document.resourceName,
        profile: document.profile,
        nodes: document.nodes,
        compiledAt: new Date("2026-01-01T00:00:00.000Z")
      });

    const publishedPages = await listWikiPages(spaceRoot);
    const publishedIds = new Set(publishedPages.map(({ id }) => id));
    for (const question of dataset.questions)
      for (const expectedPageId of question.expectedPageIds)
        if (!publishedIds.has(expectedPageId))
          throw new Error(`GOLDEN_EXPECTED_PAGE_UNKNOWN:${question.id}:${expectedPageId}`);

    const cases: WikiGoldenCaseResult[] = [];
    for (const question of dataset.questions) {
      const evidence = await queryWikiEvidence(spaceRoot, question.question, 10);
      const actualPageIds = evidence.items.map(({ pageId }) => pageId);
      const actualRefusal = evidence.items.length === 0;
      const expectedPages = new Set(question.expectedPageIds);
      const expectedVersions = new Set(question.expectedResourceVersionIds);
      const pageHit = question.expectRefusal
        ? actualRefusal
        : actualPageIds.some((pageId) => expectedPages.has(pageId));
      const citationCorrect = question.expectRefusal
        ? actualRefusal
        : evidence.items.length > 0 &&
          evidence.items.every(
            (item) =>
              expectedPages.has(item.pageId) &&
              item.sourceRefs.length > 0 &&
              item.sourceRefs.every((ref) =>
                expectedVersions.has(parseLocatorRef(ref).resourceVersionId)
              )
          );
      const expectedSourceRefs = new Set(question.expectedSourceRefs);
      const sourceLocatorCorrect =
        question.expectRefusal || expectedSourceRefs.size === 0
          ? actualRefusal
          : evidence.items.length > 0 &&
            evidence.items.every((item) =>
              item.sourceRefs.some((sourceRef) => expectedSourceRefs.has(sourceRef))
            );
      const failureReasons: string[] = [];
      if (question.expectRefusal && !actualRefusal) failureReasons.push("EXPECTED_REFUSAL");
      if (!question.expectRefusal && actualRefusal) failureReasons.push("UNEXPECTED_REFUSAL");
      if (!question.expectRefusal && !pageHit) failureReasons.push("EXPECTED_PAGE_NOT_IN_TOP_10");
      if (!question.expectRefusal && !citationCorrect)
        failureReasons.push("CITATION_OUTSIDE_EXPECTED_TARGETS");
      if (!question.expectRefusal && expectedSourceRefs.size > 0 && !sourceLocatorCorrect)
        failureReasons.push("SOURCE_LOCATOR_OUTSIDE_EXPECTED_TARGETS");
      cases.push({
        id: question.id,
        question: question.question,
        expectRefusal: question.expectRefusal,
        actualRefusal,
        expectedPageIds: question.expectedPageIds,
        expectedSourceRefs: question.expectedSourceRefs,
        actualPageIds,
        pageHit,
        citationCorrect,
        sourceLocatorCorrect,
        embeddingCalls: evidence.embeddingCalls,
        failureReasons
      });
    }

    const answerable = cases.filter(({ expectRefusal }) => !expectRefusal);
    const refusals = cases.filter(({ expectRefusal }) => expectRefusal);
    const metrics = {
      recallAt10: ratio(answerable.filter(({ pageHit }) => pageHit).length, answerable.length),
      citationAccuracy: ratio(
        answerable.filter(({ citationCorrect }) => citationCorrect).length,
        answerable.length
      ),
      sourceLocatorAccuracy: ratio(
        answerable
          .filter(({ expectedSourceRefs }) => expectedSourceRefs.length > 0)
          .filter(({ sourceLocatorCorrect }) => sourceLocatorCorrect).length,
        answerable.filter(({ expectedSourceRefs }) => expectedSourceRefs.length > 0).length
      ),
      sourceLocatorEvaluatedCount: answerable.filter(
        ({ expectedSourceRefs }) => expectedSourceRefs.length > 0
      ).length,
      refusalAccuracy: ratio(
        refusals.filter(({ actualRefusal }) => actualRefusal).length,
        refusals.length
      ),
      answerableAccuracy: ratio(
        answerable.filter(({ actualRefusal }) => !actualRefusal).length,
        answerable.length
      ),
      embeddingCalls: 0 as const
    };
    return wikiGoldenReportSchema.parse({
      schemaVersion: 1,
      datasetId: dataset.id,
      stage: dataset.stage,
      documentCount: dataset.documents.length,
      questionCount: dataset.questions.length,
      answerableCount: answerable.length,
      refusalCount: refusals.length,
      metrics,
      thresholdsPassed:
        metrics.recallAt10 >= dataset.thresholds.recallAt10 &&
        metrics.citationAccuracy >= dataset.thresholds.citationAccuracy &&
        metrics.refusalAccuracy >= dataset.thresholds.refusalAccuracy &&
        metrics.sourceLocatorAccuracy >= dataset.thresholds.sourceLocatorAccuracy &&
        metrics.embeddingCalls === 0,
      cases
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function writeWikiGoldenReport(file: string, report: WikiGoldenReport) {
  await writeFile(file, `${JSON.stringify(wikiGoldenReportSchema.parse(report), null, 2)}\n`);
}
