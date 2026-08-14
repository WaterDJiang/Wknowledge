import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBlobStore } from "@wknowledge/blob-store";
import { renderLearningReportArtifacts } from "../src/learning-report-renderer";

const roots: string[] = [];
const rendererScript = path.resolve(
  import.meta.dirname,
  "../../../runtimes/python/render_learning_report.py"
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("learning report renderer", () => {
  it("renders a frozen report into nonempty immutable PNG and PDF artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-learning-report-test-"));
    roots.push(root);
    const artifacts = await renderLearningReportArtifacts({
      snapshotId: "11111111-1111-4111-8111-111111111111",
      token: "render-token",
      report: {
        learningPlanId: "22222222-2222-4222-8222-222222222222",
        courseId: "33333333-3333-4333-8333-333333333333",
        units: { total: 2, completed: 1, completionPercent: 50 },
        practice: {
          candidateSets: 1,
          questions: 3,
          attempts: 2,
          pendingReview: 1,
          objectiveGraded: 1,
          objectiveCorrect: 1,
          objectiveScore: 1,
          objectiveMaximumScore: 1,
          traceableAttempts: 2
        },
        mastery: {
          totalKnowledgePoints: 2,
          gradedKnowledgePoints: 1,
          currentCorrect: 1,
          averagePercent: 100,
          items: [
            {
              knowledgePointId: "44444444-4444-4444-8444-444444444444",
              status: "graded",
              correct: true,
              score: 1,
              maximumScore: 1,
              percent: 100,
              updatedAt: "2026-08-14T00:00:00.000Z"
            },
            {
              knowledgePointId: "66666666-6666-4666-8666-666666666666",
              status: "ungraded",
              correct: null,
              score: null,
              maximumScore: null,
              percent: null,
              updatedAt: null
            }
          ]
        }
      },
      blobStore: new LocalBlobStore(root),
      python: "python3",
      script: rendererScript
    });
    expect(artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ format: "png", byteSize: expect.any(Number) }),
        expect.objectContaining({ format: "pdf", byteSize: expect.any(Number) })
      ])
    );
    expect(
      artifacts.every(({ byteSize, sha256 }) => byteSize > 0 && /^[a-f0-9]{64}$/.test(sha256))
    ).toBe(true);
  });

  it("does not write report Blobs when derived storage reservation is denied", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-learning-report-test-"));
    roots.push(root);
    await expect(
      renderLearningReportArtifacts({
        snapshotId: "11111111-1111-4111-8111-111111111111",
        token: "quota-token",
        report: {
          learningPlanId: "22222222-2222-4222-8222-222222222222",
          courseId: "33333333-3333-4333-8333-333333333333",
          units: { total: 1, completed: 0, completionPercent: 0 },
          practice: {
            candidateSets: 0,
            questions: 0,
            attempts: 0,
            pendingReview: 0,
            objectiveGraded: 0,
            objectiveCorrect: 0,
            objectiveScore: 0,
            objectiveMaximumScore: 0,
            traceableAttempts: 0
          },
          mastery: {
            totalKnowledgePoints: 0,
            gradedKnowledgePoints: 0,
            currentCorrect: 0,
            averagePercent: null,
            items: []
          }
        },
        blobStore: new LocalBlobStore(root),
        python: "python3",
        script: rendererScript,
        reserveStorage: async () => {
          throw new Error("STORAGE_QUOTA_EXCEEDED");
        }
      })
    ).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
    await expect((await import("node:fs/promises")).readdir(root)).resolves.toEqual([]);
  });
});
