import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ParserOutput } from "@wknowledge/contracts";
import { parserOutputSchema } from "@wknowledge/contracts";
import { renderCompiledContent } from "@wknowledge/wiki";

type StorageReservation = { commit(): Promise<void>; release(): Promise<void> };

function stagingSuffix(executionToken: string) {
  const normalized = executionToken.replaceAll(/[^a-zA-Z0-9_-]/g, "");
  if (!normalized) throw new Error("PROCESSING_EXECUTION_TOKEN_INVALID");
  return normalized;
}

export async function publishCompiledFromStaging(input: {
  dataRoot: string;
  spaceId: string;
  output: ParserOutput;
  executionToken: string;
  hasExecutionLease: () => Promise<boolean>;
  assets?: Array<{ path: string; bytes: Uint8Array }>;
  reserveStorage?: (byteSize: number) => Promise<StorageReservation>;
}): Promise<boolean> {
  const validated = parserOutputSchema.parse(input.output);
  const { document, manifest } = validated;
  const target = path.join(input.dataRoot, input.spaceId, "compiled", document.resourceVersionId);
  const staging = `${target}.staging-${stagingSuffix(input.executionToken)}`;
  const assets = input.assets ?? [];
  const assetPaths = new Set<string>();
  for (const asset of assets) {
    const normalized = path.posix.normalize(asset.path);
    if (
      normalized !== asset.path ||
      normalized.startsWith("../") ||
      path.posix.isAbsolute(normalized) ||
      !(
        /^keyframes\/frame-\d{3}\.jpg$/.test(normalized) ||
        /^pdf-pages\/page-\d{3}\.png$/.test(normalized) ||
        normalized === "pdf-pages/manifest.json"
      ) ||
      !asset.bytes.byteLength ||
      asset.bytes.byteLength >
        (normalized.startsWith("keyframes/") ? 5 * 1024 * 1024 : 8 * 1024 * 1024) ||
      assetPaths.has(normalized)
    )
      throw new Error("COMPILED_ASSET_INVALID");
    assetPaths.add(normalized);
  }
  const content = renderCompiledContent(document.nodes);
  const nodes = `${JSON.stringify(document, null, 2)}\n`;
  const parserManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  const byteSize =
    Buffer.byteLength(content, "utf8") +
    Buffer.byteLength(nodes, "utf8") +
    Buffer.byteLength(parserManifest, "utf8") +
    assets.reduce((total, asset) => total + asset.bytes.byteLength, 0);
  const storageReservation = await input.reserveStorage?.(byteSize);
  let storageCommitted = false;
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, "content.md"), content);
    await writeFile(path.join(staging, "nodes.json"), nodes);
    await writeFile(path.join(staging, "parser-manifest.json"), parserManifest);
    for (const asset of assets) {
      const assetPath = path.join(staging, asset.path);
      await mkdir(path.dirname(assetPath), { recursive: true });
      await writeFile(assetPath, asset.bytes);
    }
    if (!(await input.hasExecutionLease())) {
      await storageReservation?.release();
      return false;
    }
    await storageReservation?.commit();
    storageCommitted = true;
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    return true;
  } catch (error) {
    if (!storageCommitted) await storageReservation?.release();
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
