import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sourceLocatorSchema } from "@wknowledge/contracts";
import { evaluateLocatorCases, type LocatorEvaluationCase } from "./locator-evaluation";

const locatorTypes = new Set(["pdf", "video", "audio", "sheet", "slide", "document", "image"]);

function asRecord(input: unknown, errorCode: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(errorCode);
  return input as Record<string, unknown>;
}

function asNonEmptyString(input: unknown, errorCode: string): string {
  if (typeof input !== "string" || input.length === 0) throw new Error(errorCode);
  return input;
}

function asFraction(input: unknown, errorCode: string): number {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 1)
    throw new Error(errorCode);
  return input;
}

function loadDataset(input: unknown): {
  id: string;
  minimumAccuracy: number;
  cases: LocatorEvaluationCase[];
} {
  const dataset = asRecord(input, "LOCATOR_DATASET_INVALID");
  if (dataset.schemaVersion !== 1) throw new Error("LOCATOR_DATASET_SCHEMA_VERSION_INVALID");
  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0)
    throw new Error("LOCATOR_DATASET_CASES_INVALID");
  return {
    id: asNonEmptyString(dataset.id, "LOCATOR_DATASET_ID_INVALID"),
    minimumAccuracy:
      dataset.minimumAccuracy === undefined
        ? 1
        : asFraction(dataset.minimumAccuracy, "LOCATOR_DATASET_THRESHOLD_INVALID"),
    cases: dataset.cases.map((input, index) => {
      const item = asRecord(input, `LOCATOR_CASE_INVALID:${index}`);
      const type = asNonEmptyString(item.type, `LOCATOR_CASE_TYPE_INVALID:${index}`);
      if (!locatorTypes.has(type)) throw new Error(`LOCATOR_CASE_TYPE_INVALID:${index}`);
      const expected = sourceLocatorSchema.parse(item.expected);
      const actual = item.actual === undefined ? undefined : sourceLocatorSchema.parse(item.actual);
      if (expected.type !== type || (actual && actual.type !== type))
        throw new Error(`LOCATOR_CASE_TYPE_MISMATCH:${index}`);
      const bboxIouThreshold =
        item.bboxIouThreshold === undefined
          ? undefined
          : asFraction(item.bboxIouThreshold, `LOCATOR_CASE_BBOX_THRESHOLD_INVALID:${index}`);
      const mediaToleranceMs = item.mediaToleranceMs;
      if (
        mediaToleranceMs !== undefined &&
        (typeof mediaToleranceMs !== "number" ||
          !Number.isInteger(mediaToleranceMs) ||
          mediaToleranceMs < 0)
      )
        throw new Error(`LOCATOR_CASE_MEDIA_TOLERANCE_INVALID:${index}`);
      return {
        id: asNonEmptyString(item.id, `LOCATOR_CASE_ID_INVALID:${index}`),
        type: expected.type,
        expected,
        ...(actual ? { actual } : {}),
        ...(bboxIouThreshold === undefined ? {} : { bboxIouThreshold }),
        ...(mediaToleranceMs === undefined ? {} : { mediaToleranceMs })
      };
    })
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const datasetFile = path.resolve(argument("--dataset") ?? "eval/locators/fixture-v0.1.json");
const outputFile = argument("--output");
const dataset = loadDataset(JSON.parse(await readFile(datasetFile, "utf8")));
const report = evaluateLocatorCases(dataset.cases, {
  evaluatedAt: "2026-08-14T00:00:00.000Z",
  minimumAccuracy: dataset.minimumAccuracy
});

if (outputFile) {
  const resolvedOutput = path.resolve(outputFile);
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  await writeFile(
    resolvedOutput,
    `${JSON.stringify({ datasetId: dataset.id, ...report }, null, 2)}\n`,
    "utf8"
  );
}

console.info(`Dataset: ${dataset.id}`);
console.info(
  `Locator accuracy: ${(report.accuracy * 100).toFixed(1)}% (${report.matchedCount}/${report.evaluatedCount})`
);
for (const type of report.byType)
  console.info(
    `${type.type}: ${(type.accuracy * 100).toFixed(1)}% (${type.matchedCount}/${type.evaluatedCount})`
  );
const failures = report.cases.filter(({ failureReasons }) => failureReasons.length > 0);
if (failures.length)
  console.info(
    `Failures:\n${failures.map((item) => `- ${item.id}: ${item.failureReasons.join(", ")}`).join("\n")}`
  );
if (!report.thresholdsPassed) process.exitCode = 1;
