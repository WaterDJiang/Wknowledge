import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Docker runtime dependency installation", () => {
  it("retries transient APT downloads without weakening package verification", async () => {
    const dockerfile = await readFile(path.join(root, "deploy", "Dockerfile"), "utf8");

    expect(dockerfile).toContain("apt-get -o Acquire::Retries=3 update");
    expect(dockerfile).toContain(
      "apt-get -o Acquire::Retries=3 install -y --no-install-recommends"
    );
    expect(dockerfile).toContain("rm -rf /var/lib/apt/lists/*");
    expect(dockerfile).not.toContain("--allow-unauthenticated");
  });
});
