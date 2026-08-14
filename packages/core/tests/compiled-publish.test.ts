import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ParserOutput } from "@wknowledge/contracts";
import { publishCompiledFromStaging } from "../src/compiled-publish";

const roots: string[] = [];

function output(versionId: string): ParserOutput {
  return {
    document: {
      schemaVersion: 1,
      resourceVersionId: versionId,
      nodes: [
        {
          schemaVersion: 1,
          id: "document-1",
          kind: "paragraph",
          content: "可恢复的资料正文",
          order: 0,
          locator: { type: "document", resourceVersionId: versionId, nodeId: "document-1" },
          metadata: {}
        }
      ]
    },
    manifest: {
      schemaVersion: 1,
      parserId: "test-parser",
      parserVersion: "1.0.0",
      runtime: "node",
      mimeType: "text/markdown",
      resourceVersionId: versionId,
      generatedAt: new Date().toISOString()
    }
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("compiled staging publish", () => {
  it("does not replace compiled output or retain staging after execution ownership is lost", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wknowledge-compiled-"));
    roots.push(dataRoot);
    const spaceId = randomUUID();
    const versionId = randomUUID();
    const published = await publishCompiledFromStaging({
      dataRoot,
      spaceId,
      output: output(versionId),
      executionToken: randomUUID(),
      hasExecutionLease: async () => false
    });
    const compiledRoot = path.join(dataRoot, spaceId, "compiled");
    expect(published).toBe(false);
    await expect(readdir(compiledRoot)).resolves.toEqual([]);
  });

  it("publishes only after the current execution owner confirms its lease", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wknowledge-compiled-"));
    roots.push(dataRoot);
    const spaceId = randomUUID();
    const versionId = randomUUID();
    const published = await publishCompiledFromStaging({
      dataRoot,
      spaceId,
      output: output(versionId),
      executionToken: randomUUID(),
      hasExecutionLease: async () => true
    });
    const target = path.join(dataRoot, spaceId, "compiled", versionId);
    expect(published).toBe(true);
    await expect(readFile(path.join(target, "content.md"), "utf8")).resolves.toContain(
      "可恢复的资料正文"
    );
    await expect(readdir(target)).resolves.toEqual(
      expect.arrayContaining(["content.md", "nodes.json", "parser-manifest.json"])
    );
  });

  it("does not replace an existing compiled directory when derived storage cannot be reserved", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wknowledge-compiled-"));
    roots.push(dataRoot);
    const spaceId = randomUUID();
    const versionId = randomUUID();
    const target = path.join(dataRoot, spaceId, "compiled", versionId);
    await (await import("node:fs/promises")).mkdir(target, { recursive: true });
    await (await import("node:fs/promises")).writeFile(path.join(target, "content.md"), "旧正文");

    await expect(
      publishCompiledFromStaging({
        dataRoot,
        spaceId,
        output: output(versionId),
        executionToken: randomUUID(),
        hasExecutionLease: async () => true,
        reserveStorage: async () => {
          throw new Error("STORAGE_QUOTA_EXCEEDED");
        }
      })
    ).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
    await expect(readFile(path.join(target, "content.md"), "utf8")).resolves.toBe("旧正文");
  });

  it("publishes validated keyframe assets only with their compiled document", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wknowledge-compiled-"));
    roots.push(dataRoot);
    const spaceId = randomUUID();
    const versionId = randomUUID();
    await expect(
      publishCompiledFromStaging({
        dataRoot,
        spaceId,
        output: output(versionId),
        executionToken: randomUUID(),
        hasExecutionLease: async () => true,
        assets: [{ path: "keyframes/frame-001.jpg", bytes: new Uint8Array([1, 2, 3]) }]
      })
    ).resolves.toBe(true);
    await expect(
      readFile(path.join(dataRoot, spaceId, "compiled", versionId, "keyframes", "frame-001.jpg"))
    ).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("publishes PDF page assets and their manifest atomically with the compiled document", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wknowledge-compiled-"));
    roots.push(dataRoot);
    const spaceId = randomUUID();
    const versionId = randomUUID();
    await expect(
      publishCompiledFromStaging({
        dataRoot,
        spaceId,
        output: output(versionId),
        executionToken: randomUUID(),
        hasExecutionLease: async () => true,
        assets: [
          {
            path: "pdf-pages/page-001.png",
            bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
          },
          {
            path: "pdf-pages/manifest.json",
            bytes: Buffer.from('{"schemaVersion":1,"pages":[]}\n', "utf8")
          }
        ]
      })
    ).resolves.toBe(true);
    const target = path.join(dataRoot, spaceId, "compiled", versionId, "pdf-pages");
    await expect(readFile(path.join(target, "page-001.png"))).resolves.toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    );
    await expect(readFile(path.join(target, "manifest.json"), "utf8")).resolves.toContain(
      '"schemaVersion":1'
    );
  });

  it("rejects unsafe compiled asset paths before publishing", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wknowledge-compiled-"));
    roots.push(dataRoot);
    await expect(
      publishCompiledFromStaging({
        dataRoot,
        spaceId: randomUUID(),
        output: output(randomUUID()),
        executionToken: randomUUID(),
        hasExecutionLease: async () => true,
        assets: [{ path: "../keyframes/frame-001.jpg", bytes: new Uint8Array([1]) }]
      })
    ).rejects.toThrow("COMPILED_ASSET_INVALID");
  });
});
