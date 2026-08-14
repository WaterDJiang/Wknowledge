import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const CURRENT_WIKI_SCHEMA_VERSION = 1;
export const WIKI_SCHEMA_MANIFEST_FILE = "schema-manifest.json";

const wikiSchemaManifestSchema = z.object({
  manifestSchemaVersion: z.literal(1),
  wikiSchemaVersion: z.literal(CURRENT_WIKI_SCHEMA_VERSION),
  generatedAt: z.string().datetime({ offset: true }),
  generatedBy: z.enum(["initialize", "publish", "migration"])
});

export interface WikiSchemaInspection {
  status: "pending_manifest" | "current" | "invalid";
  wikiSchemaVersion?: number;
  issueCodes: string[];
}

export async function writeCurrentWikiSchemaManifest(
  wikiRoot: string,
  generatedBy: "initialize" | "publish" | "migration",
  generatedAt = new Date()
): Promise<void> {
  const manifest = wikiSchemaManifestSchema.parse({
    manifestSchemaVersion: 1,
    wikiSchemaVersion: CURRENT_WIKI_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    generatedBy
  });
  await writeFile(
    path.join(wikiRoot, WIKI_SCHEMA_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

export async function inspectWikiSchema(wikiRoot: string): Promise<WikiSchemaInspection> {
  const manifestPath = path.join(wikiRoot, WIKI_SCHEMA_MANIFEST_FILE);
  let status: WikiSchemaInspection["status"] = "pending_manifest";
  let wikiSchemaVersion: number | undefined;
  const issueCodes: string[] = [];
  try {
    const manifest = wikiSchemaManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8"))
    );
    status = "current";
    wikiSchemaVersion = manifest.wikiSchemaVersion;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      status = "invalid";
      issueCodes.push("WIKI_SCHEMA_MANIFEST_INVALID");
    }
  }
  const { lintWikiDirectory } = await import("./index");
  const issues = await lintWikiDirectory(wikiRoot);
  if (issues.length > 0) {
    status = "invalid";
    issueCodes.push("WIKI_SCHEMA_LINT_FAILED");
  }
  return { status, ...(wikiSchemaVersion ? { wikiSchemaVersion } : {}), issueCodes };
}
