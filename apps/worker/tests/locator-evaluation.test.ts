import { describe, expect, it } from "vitest";
import { bboxIou, evaluateLocatorCases } from "../src/locator-evaluation";

const versionId = "11111111-1111-4111-8111-111111111111";

describe("multimodal source locator evaluation", () => {
  it("reports grouped accuracy deterministically", () => {
    const input = [
      {
        id: "pdf",
        type: "pdf" as const,
        expected: {
          type: "pdf" as const,
          resourceVersionId: versionId,
          page: 1,
          bbox: [0, 0, 10, 10] as [number, number, number, number]
        },
        actual: {
          type: "pdf" as const,
          resourceVersionId: versionId,
          page: 1,
          bbox: [1, 1, 9, 9] as [number, number, number, number]
        },
        bboxIouThreshold: 0.6
      },
      {
        id: "sheet",
        type: "sheet" as const,
        expected: {
          type: "sheet" as const,
          resourceVersionId: versionId,
          sheet: "学习",
          range: "A1:B2"
        },
        actual: {
          type: "sheet" as const,
          resourceVersionId: versionId,
          sheet: "学习",
          range: "A1:B2"
        }
      }
    ];
    const first = evaluateLocatorCases(input, {
      evaluatedAt: "2026-08-14T00:00:00.000Z",
      minimumAccuracy: 1
    });
    const second = evaluateLocatorCases(input, {
      evaluatedAt: "2026-08-14T00:00:00.000Z",
      minimumAccuracy: 1
    });
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      evaluatedCount: 2,
      matchedCount: 2,
      accuracy: 1,
      thresholdsPassed: true
    });
    expect(first.byType).toEqual([
      { type: "pdf", evaluatedCount: 1, matchedCount: 1, accuracy: 1 },
      { type: "sheet", evaluatedCount: 1, matchedCount: 1, accuracy: 1 }
    ]);
    expect(bboxIou([0, 0, 10, 10], [1, 1, 9, 9])).toBeCloseTo(0.64, 5);
  });

  it("fails resource drift, exact ranges and invalid regions loudly", () => {
    const report = evaluateLocatorCases(
      [
        {
          id: "drift",
          type: "sheet",
          expected: { type: "sheet", resourceVersionId: versionId, sheet: "学习", range: "A1:B2" },
          actual: {
            type: "sheet",
            resourceVersionId: "22222222-2222-4222-8222-222222222222",
            sheet: "学习",
            range: "A1:B3"
          }
        },
        {
          id: "region",
          type: "image",
          expected: { type: "image", resourceVersionId: versionId, bbox: [0, 0, 10, 10] },
          actual: { type: "image", resourceVersionId: versionId, bbox: [2, 2, 2, 8] }
        }
      ],
      { evaluatedAt: "2026-08-14T00:00:00.000Z", minimumAccuracy: 1 }
    );
    expect(report).toMatchObject({ matchedCount: 0, accuracy: 0, thresholdsPassed: false });
    expect(report.cases[0]?.failureReasons).toEqual([
      "RESOURCE_VERSION_MISMATCH",
      "SHEET_RANGE_MISMATCH"
    ]);
    expect(report.cases[1]?.failureReasons).toEqual(["BBOX_INVALID"]);
  });
});
