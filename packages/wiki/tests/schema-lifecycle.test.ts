import { randomUUID } from "node:crypto";
import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeSpace, migrateWikiSchemaManifest } from "../src/index";
import { inspectWikiSchema, WIKI_SCHEMA_MANIFEST_FILE } from "../src/schema-lifecycle";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Wiki schema lifecycle", () => {
  it("recognizes a new v1 space as current without exposing content", async () => {
    const root = path.join("/tmp", `wknowledge-wiki-schema-${randomUUID()}`);
    roots.push(root);
    const spaceRoot = await initializeSpace(root, randomUUID());

    await expect(inspectWikiSchema(path.join(spaceRoot, "wiki"))).resolves.toEqual({
      status: "current",
      wikiSchemaVersion: 1,
      issueCodes: []
    });
  });

  it("dual-reads a legacy v1 wiki without a manifest as pending", async () => {
    const root = path.join("/tmp", `wknowledge-wiki-schema-${randomUUID()}`);
    roots.push(root);
    const spaceRoot = await initializeSpace(root, randomUUID());
    await unlink(path.join(spaceRoot, "wiki", WIKI_SCHEMA_MANIFEST_FILE));

    await expect(inspectWikiSchema(path.join(spaceRoot, "wiki"))).resolves.toEqual({
      status: "pending_manifest",
      issueCodes: []
    });
  });

  it("rejects a corrupt manifest without returning its contents", async () => {
    const root = path.join("/tmp", `wknowledge-wiki-schema-${randomUUID()}`);
    roots.push(root);
    const spaceRoot = await initializeSpace(root, randomUUID());
    const manifest = path.join(spaceRoot, "wiki", WIKI_SCHEMA_MANIFEST_FILE);
    await writeFile(manifest, '{"wikiSchemaVersion":2}\n');

    const result = await inspectWikiSchema(path.join(spaceRoot, "wiki"));
    expect(result).toEqual({ status: "invalid", issueCodes: ["WIKI_SCHEMA_MANIFEST_INVALID"] });
    await expect(readFile(manifest, "utf8")).resolves.toContain("wikiSchemaVersion");
  });

  it("only migrates legacy v1 after an explicit maintenance window", async () => {
    const root = path.join("/tmp", `wknowledge-wiki-schema-${randomUUID()}`);
    roots.push(root);
    const spaceRoot = await initializeSpace(root, randomUUID());
    const wikiRoot = path.join(spaceRoot, "wiki");
    const manifest = path.join(wikiRoot, WIKI_SCHEMA_MANIFEST_FILE);
    await unlink(manifest);
    const indexBefore = await readFile(path.join(wikiRoot, "index.md"), "utf8");

    await expect(migrateWikiSchemaManifest(spaceRoot, { quiesced: false })).rejects.toThrow(
      "WIKI_SCHEMA_MIGRATION_QUIESCED_REQUIRED"
    );
    await expect(readFile(path.join(wikiRoot, "index.md"), "utf8")).resolves.toBe(indexBefore);

    await expect(migrateWikiSchemaManifest(spaceRoot, { quiesced: true })).resolves.toEqual({
      status: "migrated",
      wikiSchemaVersion: 1
    });
    await expect(inspectWikiSchema(wikiRoot)).resolves.toMatchObject({
      status: "current",
      wikiSchemaVersion: 1
    });
    await expect(readFile(path.join(wikiRoot, "index.md"), "utf8")).resolves.toBe(indexBefore);
  });
});
