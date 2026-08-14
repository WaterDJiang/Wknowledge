import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parserOutputSchema, type ParserOutput } from "@wknowledge/contracts";
import type { DataPolicy } from "@wknowledge/contracts";
import type { ModelGateway } from "@wknowledge/model-gateway";
import { normalizeTranscriptOutput } from "./audio-transcription.js";

const execFileAsync = promisify(execFile);
const MAX_VIDEO_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_VIDEO_DURATION_MS = 2 * 60 * 60 * 1_000;
const MAX_EXTRACTED_AUDIO_BYTES = 256 * 1024 * 1024;

export interface VideoVersionForTranscription {
  id: string;
  mimeType: string;
  blobUri: string;
  originalName: string;
  byteSize: number;
}

export type VideoAudioTranscriptionResult =
  | {
      status: "completed";
      output: ParserOutput;
      providerId: string;
      model: string;
      durationMs: number;
    }
  | { status: "skipped"; output: ParserOutput; reason: string };

function audioStreamIndex(mediaProbe: ParserOutput): number | null {
  const mediaNode = mediaProbe.document.nodes.find((node) => node.locator.type === "video");
  if (!mediaNode || mediaNode.locator.type !== "video") return null;
  const audioStreams = mediaNode.metadata.audioStreams;
  if (!Array.isArray(audioStreams)) return null;
  const stream =
    audioStreams.find(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        (candidate as { default?: unknown }).default === true &&
        Number.isSafeInteger((candidate as { index?: unknown }).index)
    ) ??
    audioStreams.find(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        Number.isSafeInteger((candidate as { index?: unknown }).index)
    );
  return stream && typeof stream === "object" ? (stream as { index: number }).index : null;
}

function videoDurationMs(mediaProbe: ParserOutput): number | null {
  const mediaNode = mediaProbe.document.nodes.find((node) => node.locator.type === "video");
  return mediaNode?.locator.type === "video" ? mediaNode.locator.endMs : null;
}

export function videoProbeHasAudioStream(mediaProbe: ParserOutput): boolean {
  return audioStreamIndex(mediaProbe) !== null;
}

async function localBlobSourcePath(blobRoot: string, blobUri: string): Promise<string> {
  if (!blobUri.startsWith("local://")) throw new Error("VIDEO_ASR_REQUIRES_LOCAL_BLOB");
  const relative = path.posix.normalize(blobUri.slice("local://".length));
  if (relative.startsWith("../") || relative === ".." || path.posix.isAbsolute(relative))
    throw new Error("BLOB_PATH_OUTSIDE_ROOT");
  const sourcePath = path.join(blobRoot, relative);
  if (!(await lstat(sourcePath)).isFile()) throw new Error("VIDEO_ASR_SOURCE_UNAVAILABLE");
  return sourcePath;
}

export async function transcribeVideoAudioTrack(input: {
  version: VideoVersionForTranscription;
  mediaProbe: ParserOutput;
  blobRoot: string;
  gateway: ModelGateway;
  dataPolicy: DataPolicy;
  ffmpeg: string;
  signal?: AbortSignal;
}): Promise<VideoAudioTranscriptionResult> {
  if (input.version.mimeType !== "video/mp4") throw new Error("VIDEO_ASR_MIME_UNSUPPORTED");
  const streamIndex = audioStreamIndex(input.mediaProbe);
  if (streamIndex === null)
    return { status: "skipped", output: input.mediaProbe, reason: "VIDEO_AUDIO_STREAM_MISSING" };
  const mediaDurationMs = videoDurationMs(input.mediaProbe);
  if (!mediaDurationMs) throw new Error("VIDEO_ASR_MEDIA_PROBE_REQUIRED");
  if (input.version.byteSize > MAX_VIDEO_SOURCE_BYTES)
    return { status: "skipped", output: input.mediaProbe, reason: "VIDEO_ASR_SOURCE_TOO_LARGE" };
  if (mediaDurationMs > MAX_VIDEO_DURATION_MS)
    return { status: "skipped", output: input.mediaProbe, reason: "VIDEO_ASR_DURATION_TOO_LONG" };

  const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-video-asr-"));
  try {
    const sourcePath = await localBlobSourcePath(input.blobRoot, input.version.blobUri);
    if ((await stat(sourcePath)).size === 0) throw new Error("VIDEO_ASR_SOURCE_EMPTY");
    const audioPath = path.join(directory, "track.wav");
    try {
      await execFileAsync(
        input.ffmpeg,
        [
          "-nostdin",
          "-v",
          "error",
          "-i",
          sourcePath,
          "-map",
          `0:${streamIndex}`,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "pcm_s16le",
          "-f",
          "wav",
          audioPath
        ],
        { timeout: 60_000, signal: input.signal }
      );
    } catch (error) {
      if (input.signal?.aborted) throw error;
      return {
        status: "skipped",
        output: input.mediaProbe,
        reason: "VIDEO_AUDIO_EXTRACTION_FAILED"
      };
    }
    if ((await stat(audioPath)).size > MAX_EXTRACTED_AUDIO_BYTES)
      return { status: "skipped", output: input.mediaProbe, reason: "VIDEO_ASR_AUDIO_TOO_LARGE" };
    const audio = await readFile(audioPath);
    if (audio.byteLength === 0)
      return {
        status: "skipped",
        output: input.mediaProbe,
        reason: "VIDEO_AUDIO_EXTRACTION_FAILED"
      };
    let response;
    try {
      response = await input.gateway.invoke({
        capability: "speech_to_text",
        dataPolicy: input.dataPolicy,
        purpose: "speech_to_text",
        payload: {
          file: new Blob([new Uint8Array(audio)], { type: "audio/wav" }),
          fileName: "source.wav"
        },
        ...(input.signal ? { signal: input.signal } : {})
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (
        error instanceof Error &&
        [
          "MODEL_CAPABILITY_UNAVAILABLE",
          "MODEL_PROVIDER_UNAVAILABLE",
          "MODEL_PROVIDER_TIMEOUT",
          "MODEL_PROVIDER_HTTP_ERROR",
          "MODEL_PROVIDER_RESPONSE_INVALID"
        ].includes(error.message)
      )
        return {
          status: "skipped",
          output: input.mediaProbe,
          reason: "VIDEO_ASR_PROVIDER_UNAVAILABLE"
        };
      throw error;
    }
    const transcript = normalizeTranscriptOutput(response.output, mediaDurationMs);
    if (!transcript) throw new Error("ASR_TRANSCRIPT_INVALID");
    return {
      status: "completed",
      providerId: response.providerId,
      model: response.model,
      durationMs: response.durationMs,
      output: parserOutputSchema.parse({
        document: {
          schemaVersion: 1,
          resourceVersionId: input.version.id,
          nodes: [
            ...input.mediaProbe.document.nodes,
            ...transcript.nodes.map((node, index) => ({
              schemaVersion: 1 as const,
              id: `audio-transcript-${index + 1}`,
              kind: "transcript" as const,
              title: "视频音轨转写",
              content: node.content,
              order: input.mediaProbe.document.nodes.length + index,
              locator: {
                type: "video" as const,
                resourceVersionId: input.version.id,
                startMs: node.startMs,
                endMs: node.endMs
              },
              metadata: {
                source: "audio_track_asr",
                streamIndex,
                providerId: response.providerId,
                model: response.model,
                durationMs: response.durationMs,
                segmentation: transcript.segmentation
              }
            }))
          ]
        },
        manifest: {
          schemaVersion: 1,
          parserId: "wknowledge-worker-video-asr",
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
