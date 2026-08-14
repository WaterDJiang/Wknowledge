import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Compose Worker resource limits", () => {
  it("gives the Worker explicit, overrideable cgroup memory, CPU, and PID limits", async () => {
    const compose = await readFile(path.join(root, "docker-compose.yml"), "utf8");
    const workerService = compose.match(/\n {2}worker:\n([\s\S]*?)\n {2}backup:/)?.[1];
    expect(workerService).toBeDefined();
    expect(workerService).toContain("mem_limit: ${WKNOWLEDGE_WORKER_MEMORY_LIMIT:-2g}");
    expect(workerService).toContain('cpus: "${WKNOWLEDGE_WORKER_CPU_LIMIT:-2.0}"');
    expect(workerService).toContain("pids_limit: ${WKNOWLEDGE_WORKER_PIDS_LIMIT:-256}");
  });
});
