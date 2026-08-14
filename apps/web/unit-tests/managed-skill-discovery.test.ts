import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeSkillDigest } from "@wknowledge/skill-runtime";
import { discoverManagedSkillDefinitions } from "../lib/settings";

function manifest(input: { id: string; digest: string; entrypoint: string; dynamic?: boolean }) {
  return {
    id: input.id,
    version: "1.0.0",
    digest: input.digest,
    description: input.id,
    inputSchema: {},
    outputSchema: {},
    requiredCapabilities: [],
    permissions: {
      resources: "none",
      filesystem: "none",
      network: "deny",
      approval: "never"
    },
    limits: { timeoutSeconds: 30, memoryMb: 64, maxModelCalls: 0 },
    entrypoint: input.entrypoint
  };
}

describe("managed Skill discovery", () => {
  it("labels safe installed Skills and rejects an installed Skill that shadows a builtin ID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wknowledge-managed-skills-"));
    const builtinRoot = path.join(root, "builtin");
    const installedRoot = path.join(root, "installed");
    const builtinDirectory = path.join(builtinRoot, "wiki-lint");
    const installedDirectory = path.join(installedRoot, "safe-inspector");
    const shadowDirectory = path.join(installedRoot, "wiki-lint");
    await Promise.all([
      mkdir(builtinDirectory, { recursive: true }),
      mkdir(installedDirectory, { recursive: true }),
      mkdir(shadowDirectory, { recursive: true })
    ]);
    await writeFile(
      path.join(builtinDirectory, "skill.json"),
      JSON.stringify(
        manifest({
          id: "wiki-lint",
          digest: `sha256:${"0".repeat(64)}`,
          entrypoint: "index.ts"
        })
      )
    );
    const program = "process.exit(0);\n";
    const digest = computeSkillDigest([{ name: "run.mjs", content: Buffer.from(program) }]);
    for (const [directory, id] of [
      [installedDirectory, "safe-inspector"],
      [shadowDirectory, "wiki-lint"]
    ] as const) {
      await writeFile(path.join(directory, "run.mjs"), program);
      await writeFile(
        path.join(directory, "skill.json"),
        JSON.stringify(manifest({ id, digest, entrypoint: "typescript-json-cli" }))
      );
    }
    await expect(discoverManagedSkillDefinitions({ builtinRoot, installedRoot })).resolves.toEqual([
      expect.objectContaining({
        manifest: expect.objectContaining({ id: "safe-inspector" }),
        origin: "installed"
      }),
      expect.objectContaining({
        manifest: expect.objectContaining({ id: "wiki-lint" }),
        origin: "builtin"
      })
    ]);
  });
});
