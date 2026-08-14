import type { SourceLocator } from "@wknowledge/contracts";

export type LocatorEvaluationFailureReason =
  | "ACTUAL_LOCATOR_MISSING"
  | "LOCATOR_TYPE_MISMATCH"
  | "RESOURCE_VERSION_MISMATCH"
  | "PDF_PAGE_MISMATCH"
  | "SLIDE_MISMATCH"
  | "SHAPE_MISMATCH"
  | "SHEET_MISMATCH"
  | "SHEET_RANGE_MISMATCH"
  | "DOCUMENT_NODE_MISMATCH"
  | "MEDIA_START_MISMATCH"
  | "MEDIA_END_MISMATCH"
  | "BBOX_MISSING"
  | "BBOX_INVALID"
  | "BBOX_IOU_BELOW_THRESHOLD";

export interface LocatorEvaluationCase {
  id: string;
  type: SourceLocator["type"];
  expected: SourceLocator;
  actual?: SourceLocator;
  bboxIouThreshold?: number;
  mediaToleranceMs?: number;
}

export interface LocatorEvaluationCaseResult {
  id: string;
  type: SourceLocator["type"];
  matched: boolean;
  bboxIou?: number;
  failureReasons: LocatorEvaluationFailureReason[];
}

export interface LocatorEvaluationTypeSummary {
  type: SourceLocator["type"];
  evaluatedCount: number;
  matchedCount: number;
  accuracy: number;
}

export interface LocatorEvaluationReport {
  schemaVersion: 1;
  evaluatedAt: string;
  evaluatedCount: number;
  matchedCount: number;
  accuracy: number;
  thresholdsPassed: boolean;
  byType: LocatorEvaluationTypeSummary[];
  cases: LocatorEvaluationCaseResult[];
}

type Bbox = [number, number, number, number];

const LOCATOR_TYPES = ["pdf", "video", "audio", "sheet", "slide", "document", "image"] as const;

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function isValidBbox(bbox: Bbox): boolean {
  const [left, top, right, bottom] = bbox;
  return bbox.every(Number.isFinite) && right > left && bottom > top;
}

export function bboxIou(left: Bbox, right: Bbox): number {
  if (!isValidBbox(left) || !isValidBbox(right)) return 0;
  const intersectionLeft = Math.max(left[0], right[0]);
  const intersectionTop = Math.max(left[1], right[1]);
  const intersectionRight = Math.min(left[2], right[2]);
  const intersectionBottom = Math.min(left[3], right[3]);
  const intersectionWidth = Math.max(0, intersectionRight - intersectionLeft);
  const intersectionHeight = Math.max(0, intersectionBottom - intersectionTop);
  const intersectionArea = intersectionWidth * intersectionHeight;
  const leftArea = (left[2] - left[0]) * (left[3] - left[1]);
  const rightArea = (right[2] - right[0]) * (right[3] - right[1]);
  return intersectionArea / (leftArea + rightArea - intersectionArea);
}

function compareBbox(
  expected: Bbox | undefined,
  actual: Bbox | undefined,
  threshold: number,
  failures: LocatorEvaluationFailureReason[]
): number | undefined {
  if (!expected || !actual) {
    failures.push("BBOX_MISSING");
    return undefined;
  }
  if (!isValidBbox(expected) || !isValidBbox(actual)) {
    failures.push("BBOX_INVALID");
    return undefined;
  }
  const iou = bboxIou(expected, actual);
  if (iou < threshold) failures.push("BBOX_IOU_BELOW_THRESHOLD");
  return iou;
}

export function evaluateLocatorCase(input: LocatorEvaluationCase): LocatorEvaluationCaseResult {
  const failures: LocatorEvaluationFailureReason[] = [];
  const actual = input.actual;
  if (!actual) {
    failures.push("ACTUAL_LOCATOR_MISSING");
    return { id: input.id, type: input.type, matched: false, failureReasons: failures };
  }
  if (input.expected.type !== actual.type || input.type !== input.expected.type) {
    failures.push("LOCATOR_TYPE_MISMATCH");
    return { id: input.id, type: input.type, matched: false, failureReasons: failures };
  }
  if (input.expected.resourceVersionId !== actual.resourceVersionId)
    failures.push("RESOURCE_VERSION_MISMATCH");

  let computedBboxIou: number | undefined;
  switch (input.expected.type) {
    case "pdf": {
      if (actual.type !== "pdf") break;
      if (input.expected.page !== actual.page) failures.push("PDF_PAGE_MISMATCH");
      if (input.expected.bbox)
        computedBboxIou = compareBbox(
          input.expected.bbox,
          actual.bbox,
          input.bboxIouThreshold ?? 0.8,
          failures
        );
      break;
    }
    case "image": {
      if (actual.type !== "image") break;
      if (input.expected.bbox)
        computedBboxIou = compareBbox(
          input.expected.bbox,
          actual.bbox,
          input.bboxIouThreshold ?? 0.8,
          failures
        );
      break;
    }
    case "sheet": {
      if (actual.type !== "sheet") break;
      if (input.expected.sheet !== actual.sheet) failures.push("SHEET_MISMATCH");
      if (input.expected.range !== actual.range) failures.push("SHEET_RANGE_MISMATCH");
      break;
    }
    case "slide": {
      if (actual.type !== "slide") break;
      if (input.expected.slide !== actual.slide) failures.push("SLIDE_MISMATCH");
      if (input.expected.shapeId !== actual.shapeId) failures.push("SHAPE_MISMATCH");
      break;
    }
    case "document": {
      if (actual.type !== "document") break;
      if (input.expected.nodeId !== actual.nodeId) failures.push("DOCUMENT_NODE_MISMATCH");
      break;
    }
    case "audio":
    case "video": {
      if (actual.type !== input.expected.type) break;
      const tolerance = input.mediaToleranceMs ?? 0;
      if (Math.abs(input.expected.startMs - actual.startMs) > tolerance)
        failures.push("MEDIA_START_MISMATCH");
      if (Math.abs(input.expected.endMs - actual.endMs) > tolerance)
        failures.push("MEDIA_END_MISMATCH");
      break;
    }
  }
  return {
    id: input.id,
    type: input.type,
    matched: failures.length === 0,
    ...(computedBboxIou === undefined ? {} : { bboxIou: computedBboxIou }),
    failureReasons: failures
  };
}

export function evaluateLocatorCases(
  cases: readonly LocatorEvaluationCase[],
  options: { evaluatedAt?: string; minimumAccuracy?: number } = {}
): LocatorEvaluationReport {
  const results = cases.map(evaluateLocatorCase);
  const matchedCount = results.filter(({ matched }) => matched).length;
  const byType = LOCATOR_TYPES.map((type) => {
    const typed = results.filter((result) => result.type === type);
    const typeMatchedCount = typed.filter(({ matched }) => matched).length;
    return {
      type,
      evaluatedCount: typed.length,
      matchedCount: typeMatchedCount,
      accuracy: ratio(typeMatchedCount, typed.length)
    };
  }).filter(({ evaluatedCount }) => evaluatedCount > 0);
  const accuracy = ratio(matchedCount, results.length);
  return {
    schemaVersion: 1,
    evaluatedAt: options.evaluatedAt ?? new Date().toISOString(),
    evaluatedCount: results.length,
    matchedCount,
    accuracy,
    thresholdsPassed: accuracy >= (options.minimumAccuracy ?? 1),
    byType,
    cases: results
  };
}
