import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parserOutputSchema, type CompiledNode, type ParserOutput } from "@wknowledge/contracts";

const execFileAsync = promisify(execFile);
const FRAME_ID = /^keyframe-\d{3}$/;
const FRAME_ASSET_PATH = /^keyframes\/frame-\d{3}\.jpg$/;
const MAX_KEYFRAME_OCR_LINES_PER_FRAME = 100;

type KeyframeAsset = { path: string; bytes: Uint8Array };

export type VideoKeyframeOcrResult =
  | { status: "completed"; output: ParserOutput; lineCount: number; frameCount: number }
  | { status: "skipped"; output: ParserOutput; reason: "VIDEO_KEYFRAME_OCR_UNAVAILABLE" };

type KeyframeNode = CompiledNode & {
  locator: Extract<CompiledNode["locator"], { type: "video" }>;
};

function keyframeNodes(output: ParserOutput): KeyframeNode[] {
  return output.document.nodes.filter(
    (node): node is KeyframeNode =>
      node.kind === "image" &&
      node.locator.type === "video" &&
      node.metadata.source === "video_keyframe" &&
      FRAME_ID.test(node.id) &&
      typeof node.metadata.assetPath === "string" &&
      FRAME_ASSET_PATH.test(node.metadata.assetPath)
  );
}

function isNoTextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException & { stderr?: unknown }).stderr === "string" &&
    (error as NodeJS.ErrnoException & { stderr: string }).stderr.includes("PARSER_EMPTY_RESULT")
  );
}

function ocrNodesForFrame(input: {
  frame: KeyframeNode;
  imageOutput: ParserOutput;
  startOrder: number;
}): CompiledNode[] {
  const assetPath = input.frame.metadata.assetPath;
  if (typeof assetPath !== "string") return [];
  const sampledAtMsValue = input.frame.metadata.sampledAtMs;
  if (
    typeof sampledAtMsValue !== "number" ||
    !Number.isSafeInteger(sampledAtMsValue) ||
    sampledAtMsValue < 0
  )
    return [];
  const sampledAtMs = sampledAtMsValue;
  return input.imageOutput.document.nodes
    .filter(
      (node) =>
        node.kind === "image" &&
        node.locator.type === "image" &&
        node.locator.bbox &&
        node.metadata.contentRole === "ocr_line" &&
        typeof node.metadata.imageWidth === "number" &&
        typeof node.metadata.imageHeight === "number"
    )
    .slice(0, MAX_KEYFRAME_OCR_LINES_PER_FRAME)
    .map((node, index) => {
      if (node.locator.type !== "image" || !node.locator.bbox) throw new Error("OCR_NODE_INVALID");
      return {
        schemaVersion: 1,
        id: `${input.frame.id}-ocr-${String(index + 1).padStart(3, "0")}`,
        kind: "image",
        title: `${input.frame.title ?? input.frame.id} · 文字 ${index + 1}`,
        content: node.content,
        order: input.startOrder + index,
        locator: input.frame.locator,
        metadata: {
          source: "video_keyframe_ocr",
          contentRole: "ocr_line",
          frameId: input.frame.id,
          assetPath,
          sampledAtMs,
          imageWidth: node.metadata.imageWidth,
          imageHeight: node.metadata.imageHeight,
          bbox: node.locator.bbox,
          textTruncated: node.metadata.textTruncated === true
        }
      } satisfies CompiledNode;
    });
}

export async function extractVideoKeyframeOcr(input: {
  keyframes: ParserOutput;
  assets: readonly KeyframeAsset[];
  python: string;
  parserScript: string;
  tesseract: string;
  signal?: AbortSignal;
}): Promise<VideoKeyframeOcrResult> {
  const frames = keyframeNodes(input.keyframes);
  if (!frames.length) {
    return { status: "completed", output: input.keyframes, lineCount: 0, frameCount: 0 };
  }
  const assets = new Map(input.assets.map((asset) => [asset.path, asset.bytes]));
  if (frames.some((frame) => !assets.has(frame.metadata.assetPath as string)))
    return { status: "skipped", output: input.keyframes, reason: "VIDEO_KEYFRAME_OCR_UNAVAILABLE" };
  const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-video-keyframe-ocr-"));
  try {
    const outputNodes: CompiledNode[] = [];
    for (const frame of frames) {
      if (input.signal?.aborted) throw new Error("AbortError");
      const assetPath = frame.metadata.assetPath as string;
      const imagePath = path.join(directory, path.basename(assetPath));
      await writeFile(imagePath, assets.get(assetPath)!);
      try {
        const { stdout } = await execFileAsync(
          input.python,
          [
            input.parserScript,
            "--input",
            imagePath,
            "--mime",
            "image/jpeg",
            "--version-id",
            input.keyframes.document.resourceVersionId,
            "--tesseract",
            input.tesseract
          ],
          { maxBuffer: 5 * 1024 * 1024, timeout: 35_000, signal: input.signal }
        );
        const imageOutput = parserOutputSchema.parse(JSON.parse(stdout));
        if (
          imageOutput.document.resourceVersionId !== input.keyframes.document.resourceVersionId ||
          imageOutput.manifest.mimeType !== "image/jpeg" ||
          imageOutput.manifest.parserId !== "wknowledge-python-image-ocr"
        )
          return {
            status: "skipped",
            output: input.keyframes,
            reason: "VIDEO_KEYFRAME_OCR_UNAVAILABLE"
          };
        outputNodes.push(
          ...ocrNodesForFrame({
            frame,
            imageOutput,
            startOrder: input.keyframes.document.nodes.length + outputNodes.length
          })
        );
      } catch (error) {
        if (input.signal?.aborted) throw error;
        if (isNoTextError(error)) continue;
        return {
          status: "skipped",
          output: input.keyframes,
          reason: "VIDEO_KEYFRAME_OCR_UNAVAILABLE"
        };
      }
    }
    return {
      status: "completed",
      lineCount: outputNodes.length,
      frameCount: frames.length,
      output: parserOutputSchema.parse({
        ...input.keyframes,
        document: {
          ...input.keyframes.document,
          nodes: [...input.keyframes.document.nodes, ...outputNodes]
        },
        manifest: {
          ...input.keyframes.manifest,
          parserId: "wknowledge-worker-video-keyframe-ocr",
          parserVersion: "1.0.0",
          runtime: "node"
        }
      })
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
