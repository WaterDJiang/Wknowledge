import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parserOutputSchema, type ParserOutput } from "@wknowledge/contracts";

const execFileAsync = promisify(execFile);
const MAX_VIDEO_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_VIDEO_DURATION_MS = 2 * 60 * 60 * 1_000;
const MAX_KEYFRAME_COUNT = 8;
const KEYFRAME_INTERVAL_MS = 60_000;
const MAX_KEYFRAME_BYTES = 5 * 1024 * 1024;

export interface VideoVersionForKeyframes {
  id: string;
  mimeType: string;
  blobUri: string;
  byteSize: number;
}

export type VideoKeyframeResult =
  | {
      status: "completed";
      output: ParserOutput;
      assets: Array<{ path: string; bytes: Uint8Array }>;
    }
  | { status: "skipped"; output: ParserOutput; reason: string };

function mediaDurationMs(mediaProbe: ParserOutput): number | null {
  const node = mediaProbe.document.nodes.find((item) => item.locator.type === "video");
  return node?.locator.type === "video" ? node.locator.endMs : null;
}

function hasVideoStream(mediaProbe: ParserOutput): boolean {
  const node = mediaProbe.document.nodes.find((item) => item.locator.type === "video");
  return Boolean(
    node?.locator.type === "video" &&
    Array.isArray(node.metadata.videoStreams) &&
    node.metadata.videoStreams.length > 0
  );
}

function sampleTimes(durationMs: number): number[] {
  const samples: number[] = [];
  for (
    let atMs = 0;
    atMs < durationMs && samples.length < MAX_KEYFRAME_COUNT;
    atMs += KEYFRAME_INTERVAL_MS
  )
    samples.push(atMs);
  return samples.length ? samples : [0];
}

async function localBlobSourcePath(blobRoot: string, blobUri: string): Promise<string> {
  if (!blobUri.startsWith("local://")) throw new Error("VIDEO_KEYFRAME_REQUIRES_LOCAL_BLOB");
  const relative = path.posix.normalize(blobUri.slice("local://".length));
  if (relative.startsWith("../") || relative === ".." || path.posix.isAbsolute(relative))
    throw new Error("BLOB_PATH_OUTSIDE_ROOT");
  const sourcePath = path.join(blobRoot, relative);
  if (!(await lstat(sourcePath)).isFile()) throw new Error("VIDEO_KEYFRAME_SOURCE_UNAVAILABLE");
  return sourcePath;
}

function frameNode(input: { versionId: string; atMs: number; durationMs: number; index: number }) {
  const frameId = `keyframe-${String(input.index).padStart(3, "0")}`;
  return {
    schemaVersion: 1 as const,
    id: frameId,
    kind: "image" as const,
    title: `视频关键帧 ${input.index}`,
    content: `原始视频画面帧 · ${Math.floor(input.atMs / 1000)} 秒`,
    order: input.index,
    locator: {
      type: "video" as const,
      resourceVersionId: input.versionId,
      startMs: input.atMs,
      endMs: Math.min(input.durationMs, input.atMs + 1)
    },
    metadata: {
      source: "video_keyframe",
      contentRole: "original_frame",
      sampledAtMs: input.atMs,
      assetPath: `keyframes/frame-${String(input.index).padStart(3, "0")}.jpg`,
      imageMaxDimension: 960
    }
  };
}

export async function extractVideoKeyframes(input: {
  version: VideoVersionForKeyframes;
  mediaProbe: ParserOutput;
  blobRoot: string;
  ffmpeg: string;
  signal?: AbortSignal;
}): Promise<VideoKeyframeResult> {
  if (input.version.mimeType !== "video/mp4") throw new Error("VIDEO_KEYFRAME_MIME_UNSUPPORTED");
  if (!hasVideoStream(input.mediaProbe))
    return { status: "skipped", output: input.mediaProbe, reason: "VIDEO_STREAM_MISSING" };
  const durationMs = mediaDurationMs(input.mediaProbe);
  if (!durationMs) throw new Error("VIDEO_KEYFRAME_MEDIA_PROBE_REQUIRED");
  if (input.version.byteSize > MAX_VIDEO_SOURCE_BYTES)
    return {
      status: "skipped",
      output: input.mediaProbe,
      reason: "VIDEO_KEYFRAME_SOURCE_TOO_LARGE"
    };
  if (durationMs > MAX_VIDEO_DURATION_MS)
    return {
      status: "skipped",
      output: input.mediaProbe,
      reason: "VIDEO_KEYFRAME_DURATION_TOO_LONG"
    };

  const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-video-keyframes-"));
  try {
    const sourcePath = await localBlobSourcePath(input.blobRoot, input.version.blobUri);
    if ((await stat(sourcePath)).size === 0) throw new Error("VIDEO_KEYFRAME_SOURCE_EMPTY");
    const extracted: Array<{ path: string; bytes: Uint8Array }> = [];
    const nodes = [];
    for (const [zeroIndex, atMs] of sampleTimes(durationMs).entries()) {
      const index = zeroIndex + 1;
      const name = `frame-${String(index).padStart(3, "0")}.jpg`;
      const outputPath = path.join(directory, name);
      try {
        await execFileAsync(
          input.ffmpeg,
          [
            "-nostdin",
            "-v",
            "error",
            "-ss",
            (atMs / 1_000).toFixed(3),
            "-i",
            sourcePath,
            "-frames:v",
            "1",
            "-vf",
            "scale=960:-2:force_original_aspect_ratio=decrease",
            "-q:v",
            "3",
            "-f",
            "image2",
            outputPath
          ],
          { timeout: 30_000, signal: input.signal }
        );
      } catch (error) {
        if (input.signal?.aborted) throw error;
        return {
          status: "skipped",
          output: input.mediaProbe,
          reason: "VIDEO_KEYFRAME_EXTRACTION_FAILED"
        };
      }
      const bytes = await readFile(outputPath);
      if (!bytes.byteLength || bytes.byteLength > MAX_KEYFRAME_BYTES)
        return {
          status: "skipped",
          output: input.mediaProbe,
          reason: "VIDEO_KEYFRAME_OUTPUT_INVALID"
        };
      extracted.push({ path: `keyframes/${name}`, bytes });
      nodes.push(frameNode({ versionId: input.version.id, atMs, durationMs, index }));
    }
    return {
      status: "completed",
      assets: extracted,
      output: parserOutputSchema.parse({
        document: {
          schemaVersion: 1,
          resourceVersionId: input.version.id,
          nodes: [
            ...input.mediaProbe.document.nodes,
            ...nodes.map((node, index) => ({
              ...node,
              order: input.mediaProbe.document.nodes.length + index
            }))
          ]
        },
        manifest: {
          schemaVersion: 1,
          parserId: "wknowledge-worker-video-keyframes",
          parserVersion: "1.0.0",
          runtime: "node",
          mimeType: input.version.mimeType,
          resourceVersionId: input.version.id,
          generatedAt: new Date().toISOString()
        }
      })
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
