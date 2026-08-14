import path from "node:path";
import { inspectWikiSchema } from "./schema-lifecycle";
import { migrateWikiSchemaManifest } from "./index";

const mode = process.argv[2];
const spaceId = process.argv[3];
const dataRoot = path.resolve(process.env.WKNOWLEDGE_DATA_ROOT ?? "../../data/spaces");

if ((mode !== "check" && mode !== "migrate") || !spaceId || !/^[0-9a-f-]{36}$/i.test(spaceId)) {
  console.error("WIKI_SCHEMA_USAGE_INVALID");
  process.exitCode = 2;
} else {
  const spaceRoot = path.join(dataRoot, spaceId);
  try {
    if (mode === "check") {
      const inspection = await inspectWikiSchema(path.join(spaceRoot, "wiki"));
      if (inspection.status === "invalid") throw new Error("WIKI_SCHEMA_INVALID");
      console.log(
        JSON.stringify({
          status: inspection.status,
          ...(inspection.wikiSchemaVersion
            ? { wikiSchemaVersion: inspection.wikiSchemaVersion }
            : {})
        })
      );
    } else {
      const result = await migrateWikiSchemaManifest(spaceRoot, {
        quiesced: process.env.WKNOWLEDGE_WIKI_MIGRATION_QUIESCED === "true"
      });
      console.log(JSON.stringify(result));
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    console.error(
      [
        "WIKI_SCHEMA_INVALID",
        "WIKI_SCHEMA_LINT_FAILED",
        "WIKI_SCHEMA_MIGRATION_QUIESCED_REQUIRED"
      ].includes(code)
        ? code
        : "WIKI_SCHEMA_OPERATION_FAILED"
    );
    process.exitCode = 1;
  }
}
