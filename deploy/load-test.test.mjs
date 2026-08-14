import { describe, expect, it } from "vitest";
import { parseLoadArguments, runLoadBaseline, summarizeLoadResults } from "./load-test-core.mjs";

describe("load baseline", () => {
  it("defaults to the local liveness endpoint and rejects unapproved remote targets", () => {
    expect(parseLoadArguments([], {})).toMatchObject({
      target: "http://127.0.0.1:3000/api/health",
      requests: 100,
      concurrency: 10
    });
    expect(() => parseLoadArguments(["--url", "https://example.com/api/health"], {})).toThrow(
      "LOAD_REMOTE_NOT_ALLOWED"
    );
    expect(() => parseLoadArguments(["--url", "http://127.0.0.1:3000/workspace"], {})).toThrow(
      "LOAD_TARGET_INVALID"
    );
    expect(parseLoadArguments(["--", "--requests", "12"], {})).toMatchObject({ requests: 12 });
  });

  it("summarizes latency without response bodies or request credentials", () => {
    expect(
      summarizeLoadResults({
        elapsedMs: 100,
        results: [
          { status: 200, durationMs: 4, timeout: false },
          { status: 200, durationMs: 10, timeout: false },
          { status: 503, durationMs: 20, timeout: false }
        ]
      })
    ).toEqual({
      completedRequests: 3,
      succeededRequests: 2,
      failedRequests: 1,
      timeoutCount: 0,
      throughputPerSecond: 30,
      latencyMs: { p50: 4, p95: 10, p99: 10, max: 10 }
    });
  });

  it("keeps failed requests in counts and never reads the response body", async () => {
    const fetcher = async () => new Response("private response body", { status: 503 });
    const report = await runLoadBaseline({
      target: "http://127.0.0.1:3000/api/health",
      requests: 3,
      concurrency: 2,
      timeoutMs: 1_000,
      fetcher
    });
    expect(report.result).toMatchObject({ completedRequests: 3, failedRequests: 3 });
    expect(JSON.stringify(report)).not.toContain("private response body");
  });
});
