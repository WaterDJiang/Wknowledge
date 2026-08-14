import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { BlobStore } from "@wknowledge/blob-store";
import { parserOutputSchema, type CompiledNode, type ParserOutput } from "@wknowledge/contracts";

const execFileAsync = promisify(execFile);
const MAX_TEXT_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_LINES = 100_000;
const MAX_TEXT_NODES = 10_000;
const MAX_TEXT_NODE_BYTES = 32 * 1024;

export interface ResourceVersionForParsing {
  id: string;
  mimeType: string;
  blobUri: string;
}

export interface WorkerParserOptions {
  blobStore: BlobStore;
  blobRoot: string;
  python: string;
  parserScript: string;
  ffprobe: string;
  ffmpeg: string;
  tesseract?: string;
}

function documentLocator(resourceVersionId: string, nodeId: string) {
  return { type: "document" as const, resourceVersionId, nodeId };
}

function parseTextNodes(content: string, mimeType: string, versionId: string): CompiledNode[] {
  if (!content.trim()) throw new Error("PARSER_EMPTY_RESULT");

  const lines = content.split(/\r?\n/);
  if (lines.length > MAX_TEXT_LINES) throw new Error("TEXT_NODE_LIMIT");
  const nodes: CompiledNode[] = [];
  const headingStack: Array<{ id: string; level: number }> = [];
  let headingCount = 0;
  let paragraphCount = 0;
  let paragraphStart = -1;
  let paragraphLines: string[] = [];
  let paragraphBytes = 0;

  const currentParentId = () => headingStack.at(-1)?.id;
  const flushParagraph = (lineEnd: number) => {
    const paragraph = paragraphLines.join("\n").trim();
    if (!paragraph) return;
    if (nodes.length >= MAX_TEXT_NODES) throw new Error("TEXT_NODE_LIMIT");
    paragraphCount += 1;
    const id = `paragraph-${paragraphCount}`;
    nodes.push({
      schemaVersion: 1,
      id,
      kind: "paragraph",
      content: paragraph,
      ...(currentParentId() ? { parentId: currentParentId() } : {}),
      order: nodes.length,
      locator: documentLocator(versionId, id),
      metadata: { lineStart: paragraphStart + 1, lineEnd }
    });
    paragraphLines = [];
    paragraphStart = -1;
    paragraphBytes = 0;
  };

  for (const [lineIndex, line] of lines.entries()) {
    const heading = mimeType === "text/markdown" ? /^(#{1,6})\s+(.+)$/.exec(line) : null;
    if (heading) {
      flushParagraph(lineIndex);
      const level = heading[1]!.length;
      const title = heading[2]!.trim();
      if (Buffer.byteLength(title, "utf8") > MAX_TEXT_NODE_BYTES)
        throw new Error("TEXT_NODE_LIMIT");
      if (nodes.length >= MAX_TEXT_NODES) throw new Error("TEXT_NODE_LIMIT");
      headingCount += 1;
      const id = `heading-${headingCount}`;
      while (headingStack.at(-1) && headingStack.at(-1)!.level >= level) headingStack.pop();
      nodes.push({
        schemaVersion: 1,
        id,
        kind: "heading",
        title,
        content: title,
        ...(currentParentId() ? { parentId: currentParentId() } : {}),
        order: nodes.length,
        locator: documentLocator(versionId, id),
        metadata: { level, lineStart: lineIndex + 1, lineEnd: lineIndex + 1 }
      });
      headingStack.push({ id, level });
    } else if (line.trim()) {
      if (paragraphStart < 0) paragraphStart = lineIndex;
      paragraphBytes += Buffer.byteLength(line, "utf8") + (paragraphLines.length ? 1 : 0);
      if (paragraphBytes > MAX_TEXT_NODE_BYTES) throw new Error("TEXT_NODE_LIMIT");
      paragraphLines.push(line);
    } else {
      flushParagraph(lineIndex);
    }
  }
  flushParagraph(lines.length);
  return nodes;
}

function nodeParserOutput(
  nodes: CompiledNode[],
  versionId: string,
  mimeType: string
): ParserOutput {
  return parserOutputSchema.parse({
    document: { schemaVersion: 1, resourceVersionId: versionId, nodes },
    manifest: {
      schemaVersion: 1,
      parserId: "wknowledge-node-text",
      parserVersion: "1.0.0",
      runtime: "node",
      mimeType,
      resourceVersionId: versionId,
      generatedAt: new Date().toISOString()
    }
  });
}

export function createWorkerResourceParser(options: WorkerParserOptions) {
  const parseWithPython = async (
    filePath: string,
    mimeType: string,
    versionId: string,
    signal?: AbortSignal
  ): Promise<ParserOutput> => {
    const { stdout } = await execFileAsync(
      options.python,
      [
        options.parserScript,
        "--input",
        filePath,
        "--mime",
        mimeType,
        "--version-id",
        versionId,
        "--ffprobe",
        options.ffprobe,
        "--ffmpeg",
        options.ffmpeg,
        "--tesseract",
        options.tesseract ?? "tesseract"
      ],
      { maxBuffer: 50 * 1024 * 1024, timeout: 10 * 60 * 1000, signal }
    );
    const result = parserOutputSchema.parse(JSON.parse(stdout));
    if (result.document.resourceVersionId !== versionId)
      throw new Error("PARSER_OUTPUT_SOURCE_VERSION_MISMATCH");
    if (result.manifest.mimeType !== mimeType) throw new Error("PARSER_OUTPUT_MIME_MISMATCH");
    if (result.manifest.runtime !== "python") throw new Error("PARSER_OUTPUT_RUNTIME_MISMATCH");
    return result;
  };

  return {
    async parseVersion(
      version: ResourceVersionForParsing,
      signal?: AbortSignal
    ): Promise<ParserOutput> {
      if (version.mimeType === "text/plain" || version.mimeType === "text/markdown") {
        const bytes = await options.blobStore.read(version.blobUri);
        if (bytes.byteLength > MAX_TEXT_SOURCE_BYTES) throw new Error("TEXT_SOURCE_SIZE_LIMIT");
        const content = bytes.toString("utf8");
        return nodeParserOutput(
          parseTextNodes(content, version.mimeType, version.id),
          version.id,
          version.mimeType
        );
      }
      if (!version.blobUri.startsWith("local://"))
        throw new Error("PYTHON_PARSER_REQUIRES_LOCAL_BLOB");
      const relative = path.posix.normalize(version.blobUri.slice("local://".length));
      if (relative.startsWith("../") || path.posix.isAbsolute(relative))
        throw new Error("BLOB_PATH_OUTSIDE_ROOT");
      return parseWithPython(
        path.join(options.blobRoot, relative),
        version.mimeType,
        version.id,
        signal
      );
    }
  };
}
