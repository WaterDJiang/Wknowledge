import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateWikiGoldenDataset,
  loadWikiGoldenDataset,
  validateWikiGoldenReviewManifest,
  wikiGoldenDatasetSha256
} from "../src/evaluation";

describe("wiki golden evaluation", () => {
  it("runs the versioned pilot dataset deterministically without embeddings", async () => {
    const dataset = await loadWikiGoldenDataset(
      path.resolve(process.cwd(), "eval/wiki/golden-v0.1.json")
    );
    const first = await evaluateWikiGoldenDataset(dataset);
    const second = await evaluateWikiGoldenDataset(dataset);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      datasetId: "wiki-golden-v0.1",
      stage: "pilot",
      documentCount: 6,
      questionCount: 12,
      answerableCount: 8,
      refusalCount: 4,
      thresholdsPassed: true
    });
    expect(first.metrics.embeddingCalls).toBe(0);
    expect(first.metrics.sourceLocatorEvaluatedCount).toBe(0);
    expect(first.cases.filter(({ failureReasons }) => failureReasons.length > 0)).toEqual([]);
  });

  it("requires approved, complete and source-annotated blind reviews for the formal gate", async () => {
    const pilot = await loadWikiGoldenDataset(
      path.resolve(process.cwd(), "eval/wiki/golden-v0.1.json")
    );
    const dataset = {
      ...pilot,
      id: "wiki-golden-blind-fixture-v0.1",
      stage: "blind" as const,
      thresholds: { ...pilot.thresholds, sourceLocatorAccuracy: 0.95 },
      documents: Array.from({ length: 100 }, (_, index) => ({
        ...pilot.documents[0]!,
        id: `doc-${String(index + 1).padStart(3, "0")}`,
        resourceVersionId: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        nodes: pilot.documents[0]!.nodes.map((node) => ({
          ...node,
          locator: {
            ...node.locator,
            resourceVersionId: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
          }
        }))
      })),
      questions: Array.from({ length: 50 }, (_, index) => ({
        ...pilot.questions[0]!,
        id: `question-${String(index + 1).padStart(3, "0")}`,
        expectedResourceVersionIds: [
          `30000000-0000-4000-8000-${String((index % 100) + 1).padStart(12, "0")}`
        ],
        expectedSourceRefs: [
          "wk://source/30000000-0000-4000-8000-000000000001/eyJ0eXBlIjoiZG9jdW1lbnQiLCJyZXNvdXJjZVZlcnNpb25JZCI6IjMwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsIm5vZGVJZCI6InJldHJpZXZhbC1wcmFjdGljZSJ9"
        ]
      }))
    };
    const manifest = {
      schemaVersion: 1 as const,
      datasetId: dataset.id,
      datasetSha256: wikiGoldenDatasetSha256(dataset),
      stage: "blind" as const,
      status: "approved" as const,
      createdAt: "2026-08-13T00:00:00.000Z",
      approvedAt: "2026-08-13T00:01:00.000Z",
      documentReviews: dataset.documents.map((document) => ({
        documentId: document.id,
        authorizationRefId: `auth-${document.id}`,
        redactionReviewRefId: `redact-${document.id}`,
        reviewerId: "reviewer-01",
        reviewedAt: "2026-08-13T00:00:00.000Z"
      })),
      questionReviews: dataset.questions.map((question) => ({
        questionId: question.id,
        annotationRefId: `annotation-${question.id}`,
        annotatorId: "annotator-01",
        reviewerId: "reviewer-01",
        reviewedAt: "2026-08-13T00:00:00.000Z",
        expectedPageIds: question.expectedPageIds,
        expectedResourceVersionIds: question.expectedResourceVersionIds,
        expectedSourceRefs: question.expectedSourceRefs
      }))
    };
    expect(() =>
      validateWikiGoldenReviewManifest(dataset, manifest, { formal: true })
    ).not.toThrow();
    expect(() =>
      validateWikiGoldenReviewManifest(
        dataset,
        { ...manifest, status: "draft", approvedAt: null },
        { formal: true }
      )
    ).toThrow("GOLDEN_REVIEW_NOT_APPROVED");
    expect(() =>
      validateWikiGoldenReviewManifest(
        dataset,
        { ...manifest, questionReviews: manifest.questionReviews.slice(1) },
        { formal: true }
      )
    ).toThrow("GOLDEN_REVIEW_QUESTION_COVERAGE_INVALID");
    expect(() =>
      validateWikiGoldenReviewManifest({ ...dataset, stage: "development" }, manifest, {
        formal: true
      })
    ).toThrow("GOLDEN_REVIEW_DATASET_SHA256_MISMATCH");
    const insufficientThresholdDataset = {
      ...dataset,
      thresholds: { ...dataset.thresholds, recallAt10: 0.84 }
    };
    expect(() =>
      validateWikiGoldenReviewManifest(
        insufficientThresholdDataset,
        {
          ...manifest,
          datasetSha256: wikiGoldenDatasetSha256(insufficientThresholdDataset)
        },
        { formal: true }
      )
    ).toThrow("GOLDEN_FORMAL_REQUIRES_RECALL_THRESHOLD");
  });
});
