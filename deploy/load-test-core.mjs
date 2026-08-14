const DEFAULT_TARGET = "http://127.0.0.1:3000/api/health";
const ALLOWED_PATHS = new Set(["/api/health", "/api/health/ready"]);

function positiveInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`LOAD_${name}_INVALID`);
  return parsed;
}

export function parseLoadArguments(args, environment = process.env) {
  const values = new Map();
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const key = normalizedArgs[index];
    if (!key?.startsWith("--")) throw new Error("LOAD_ARGUMENT_INVALID");
    const value = normalizedArgs[index + 1];
    if (!value || value.startsWith("--")) throw new Error("LOAD_ARGUMENT_INVALID");
    if (!["--url", "--requests", "--concurrency", "--timeout-ms"].includes(key))
      throw new Error("LOAD_ARGUMENT_INVALID");
    if (values.has(key)) throw new Error("LOAD_ARGUMENT_INVALID");
    values.set(key, value);
    index += 1;
  }
  const target = new URL(values.get("--url") ?? DEFAULT_TARGET);
  if (target.search || target.hash || !ALLOWED_PATHS.has(target.pathname))
    throw new Error("LOAD_TARGET_INVALID");
  const local = target.protocol === "http:" && ["127.0.0.1", "localhost"].includes(target.hostname);
  if (!local && environment.WKNOWLEDGE_LOAD_ALLOW_REMOTE !== "true")
    throw new Error("LOAD_REMOTE_NOT_ALLOWED");
  return {
    target: target.toString(),
    requests: positiveInteger(values.get("--requests") ?? "100", "REQUESTS", 1, 100_000),
    concurrency: positiveInteger(values.get("--concurrency") ?? "10", "CONCURRENCY", 1, 500),
    timeoutMs: positiveInteger(values.get("--timeout-ms") ?? "5000", "TIMEOUT", 100, 60_000)
  };
}

export function percentile(values, percentileValue) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)
  );
  return Math.round(sorted[index] ?? 0);
}

export function summarizeLoadResults(input) {
  const succeeded = input.results.filter((result) => result.status >= 200 && result.status < 400);
  const durations = succeeded.map((result) => result.durationMs);
  return {
    completedRequests: input.results.length,
    succeededRequests: succeeded.length,
    failedRequests: input.results.length - succeeded.length,
    timeoutCount: input.results.filter((result) => result.timeout).length,
    throughputPerSecond:
      input.elapsedMs === 0
        ? 0
        : Number((input.results.length / (input.elapsedMs / 1_000)).toFixed(2)),
    latencyMs: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
      max: durations.length ? Math.max(...durations) : 0
    }
  };
}

export async function runLoadBaseline(input) {
  const now = input.now ?? (() => performance.now());
  const fetcher = input.fetcher ?? fetch;
  const results = [];
  let nextRequest = 0;
  const startedAt = now();
  async function worker() {
    while (nextRequest < input.requests) {
      nextRequest += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
      const requestStartedAt = now();
      try {
        const response = await fetcher(input.target, { method: "GET", signal: controller.signal });
        results.push({
          status: response.status,
          durationMs: Math.max(0, now() - requestStartedAt),
          timeout: false
        });
      } catch {
        results.push({
          status: 0,
          durationMs: Math.max(0, now() - requestStartedAt),
          timeout: controller.signal.aborted
        });
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(input.concurrency, input.requests) }, worker));
  const elapsedMs = Math.max(0, now() - startedAt);
  const target = new URL(input.target);
  return {
    schemaVersion: 1,
    kind: "wknowledge-load-baseline",
    completedAt: new Date().toISOString(),
    target: { origin: target.origin, path: target.pathname },
    config: {
      requests: input.requests,
      concurrency: input.concurrency,
      timeoutMs: input.timeoutMs
    },
    result: summarizeLoadResults({ results, elapsedMs })
  };
}
