import { parseLoadArguments, runLoadBaseline } from "./load-test-core.mjs";

try {
  const options = parseLoadArguments(process.argv.slice(2));
  const report = await runLoadBaseline(options);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.result.failedRequests > 0) process.exitCode = 1;
} catch (error) {
  const code = error instanceof Error ? error.message : "LOAD_EXECUTION_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 2;
}
