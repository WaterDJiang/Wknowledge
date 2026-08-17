import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Compose public signup configuration", () => {
  it("passes signup delivery configuration to Web without exposing it to Worker", async () => {
    const compose = await readFile(path.join(root, "docker-compose.yml"), "utf8");
    const webService = compose.match(/\n {2}web:\n([\s\S]*?)\n {2}worker:/)?.[1];
    const workerService = compose.match(/\n {2}worker:\n([\s\S]*?)\n {2}backup:/)?.[1];

    expect(webService).toContain("WKNOWLEDGE_ALLOW_SIGNUP: ${WKNOWLEDGE_ALLOW_SIGNUP:-false}");
    expect(webService).toContain("WKNOWLEDGE_RESEND_API_KEY: ${WKNOWLEDGE_RESEND_API_KEY:-}");
    expect(webService).toContain("WKNOWLEDGE_SMTP_PASSWORD: ${WKNOWLEDGE_SMTP_PASSWORD:-}");
    expect(workerService).not.toContain("WKNOWLEDGE_RESEND_API_KEY");
    expect(workerService).not.toContain("WKNOWLEDGE_SMTP_PASSWORD");
  });
});
