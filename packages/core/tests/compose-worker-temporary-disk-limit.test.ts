import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Compose Worker temporary disk limit", () => {
  it("bounds Worker scratch files without replacing the persistent data volume", async () => {
    const compose = await readFile(path.join(root, "docker-compose.yml"), "utf8");
    const workerService = compose.match(/\n {2}worker:\n([\s\S]*?)\n {2}backup:/)?.[1];

    expect(workerService).toBeDefined();
    expect(workerService).toContain("tmpfs:");
    expect(workerService).toContain("/tmp:size=${WKNOWLEDGE_WORKER_TMPFS_SIZE:-1g},mode=1777");
    expect(workerService).toContain("- wknowledge-data:/app/data");
    expect(workerService).not.toContain("wknowledge-data:/tmp");
  });
});
