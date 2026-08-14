import path from "node:path";
import {
  evaluateWikiGoldenDataset,
  loadWikiGoldenDataset,
  loadWikiGoldenReviewManifest,
  writeWikiGoldenReport
} from "./evaluation";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const datasetFile = path.resolve(argument("--dataset") ?? "eval/wiki/golden-v0.1.json");
const outputFile = argument("--output");
const reviewFile = argument("--review");
const formal = process.argv.includes("--formal");
const dataset = await loadWikiGoldenDataset(datasetFile);
const reviewManifest = reviewFile
  ? await loadWikiGoldenReviewManifest(path.resolve(reviewFile))
  : undefined;
const report = await evaluateWikiGoldenDataset(dataset, {
  ...(reviewManifest ? { reviewManifest } : {}),
  formal
});
if (outputFile) await writeWikiGoldenReport(path.resolve(outputFile), report);

console.info(`Dataset: ${report.datasetId} (${report.stage})`);
console.info(`Documents: ${report.documentCount}; questions: ${report.questionCount}`);
console.info(`Recall@10: ${(report.metrics.recallAt10 * 100).toFixed(1)}%`);
console.info(`Citation accuracy: ${(report.metrics.citationAccuracy * 100).toFixed(1)}%`);
console.info(
  `Source locator accuracy: ${(report.metrics.sourceLocatorAccuracy * 100).toFixed(1)}% (${report.metrics.sourceLocatorEvaluatedCount} evaluated)`
);
console.info(`Refusal accuracy: ${(report.metrics.refusalAccuracy * 100).toFixed(1)}%`);
console.info(`Answerable accuracy: ${(report.metrics.answerableAccuracy * 100).toFixed(1)}%`);
console.info(`Embedding calls: ${report.metrics.embeddingCalls}`);
const failures = report.cases.filter(({ failureReasons }) => failureReasons.length > 0);
if (failures.length)
  console.info(
    `Failures:\n${failures.map((item) => `- ${item.id}: ${item.failureReasons.join(", ")} expected=${item.expectedPageIds.join("|")} actual=${item.actualPageIds.join("|")}`).join("\n")}`
  );
if (!report.thresholdsPassed) process.exitCode = 1;
