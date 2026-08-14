import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { LocalBlobStore } from "@wknowledge/blob-store";
import type { ModelGateway } from "@wknowledge/model-gateway";
import { createWorkerResourceParser } from "../src/resource-parser.js";
import {
  transcribeVideoAudioTrack,
  videoProbeHasAudioStream
} from "../src/video-audio-transcription.js";
import { evaluateLocatorCases } from "../src/locator-evaluation.js";

const execFileAsync = promisify(execFile);
const python = process.env.WKNOWLEDGE_PYTHON ?? "python3";
const ffmpeg = process.env.WKNOWLEDGE_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.WKNOWLEDGE_FFPROBE ?? "ffprobe";
const parserScript = path.resolve(
  import.meta.dirname,
  "../../../runtimes/python/parse_document.py"
);
const versionId = "11111111-1111-4111-8111-111111111111";

async function createMp4Fixture(directory: string, withAudio: boolean): Promise<string> {
  const file = path.join(directory, withAudio ? "with-audio.mp4" : "silent.mp4");
  const args = [
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:d=1.25",
    ...(withAudio
      ? ["-f", "lavfi", "-i", "sine=frequency=440:duration=1.25", "-shortest", "-c:a", "aac"]
      : []),
    "-c:v",
    "mpeg4",
    "-y",
    file
  ];
  await execFileAsync(ffmpeg, args);
  return file;
}

describe("Worker video audio transcription", () => {
  it("extracts a Worker-owned video track and writes video-time transcript nodes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-video-asr-test-"));
    try {
      const fixture = await createMp4Fixture(directory, true);
      const blobRoot = path.join(directory, "blobs");
      const blobStore = new LocalBlobStore(blobRoot);
      const blobUri = await blobStore.putImmutable(
        `space/resource/${versionId}/source.mp4`,
        await readFile(fixture)
      );
      const parser = createWorkerResourceParser({
        blobStore,
        blobRoot,
        python,
        parserScript,
        ffprobe,
        ffmpeg
      });
      const mediaProbe = await parser.parseVersion({
        id: versionId,
        mimeType: "video/mp4",
        blobUri
      });
      const invoke = vi.fn(async () => ({
        providerId: "local-asr",
        model: "whisper",
        output: {
          text: "视频音轨文本。",
          segments: [{ startMs: 0, endMs: 1_000, text: "视频音轨文本。" }]
        },
        durationMs: 27
      }));

      const result = await transcribeVideoAudioTrack({
        version: {
          id: versionId,
          mimeType: "video/mp4",
          blobUri,
          originalName: "课堂视频.mp4",
          byteSize: (await readFile(fixture)).byteLength
        },
        mediaProbe,
        blobRoot,
        gateway: { invoke } as unknown as ModelGateway,
        dataPolicy: "local_only",
        ffmpeg
      });

      expect(videoProbeHasAudioStream(mediaProbe)).toBe(true);
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "speech_to_text",
          payload: expect.objectContaining({ fileName: "source.wav" })
        })
      );
      expect(result).toMatchObject({ status: "completed" });
      if (result.status === "completed") {
        expect(result.output.document.nodes.at(-1)).toMatchObject({
          id: "audio-transcript-1",
          kind: "transcript",
          content: "视频音轨文本。",
          locator: { type: "video", resourceVersionId: versionId, startMs: 0, endMs: 1_000 },
          metadata: { source: "audio_track_asr", segmentation: "provider_segments" }
        });
        const report = evaluateLocatorCases(
          [
            {
              id: "video-audio-track-segment",
              type: "video",
              expected: { type: "video", resourceVersionId: versionId, startMs: 0, endMs: 1_000 },
              actual: result.output.document.nodes.find(({ id }) => id === "audio-transcript-1")
                ?.locator
            }
          ],
          { evaluatedAt: "2026-08-14T00:00:00.000Z", minimumAccuracy: 1 }
        );
        expect(report).toMatchObject({ evaluatedCount: 1, matchedCount: 1, accuracy: 1 });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("skips ASR for a valid video container without an audio stream", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-video-asr-test-"));
    try {
      const fixture = await createMp4Fixture(directory, false);
      const blobRoot = path.join(directory, "blobs");
      const blobStore = new LocalBlobStore(blobRoot);
      const blobUri = await blobStore.putImmutable(
        `space/resource/${versionId}/silent.mp4`,
        await readFile(fixture)
      );
      const parser = createWorkerResourceParser({
        blobStore,
        blobRoot,
        python,
        parserScript,
        ffprobe,
        ffmpeg
      });
      const mediaProbe = await parser.parseVersion({
        id: versionId,
        mimeType: "video/mp4",
        blobUri
      });
      const invoke = vi.fn();

      const result = await transcribeVideoAudioTrack({
        version: {
          id: versionId,
          mimeType: "video/mp4",
          blobUri,
          originalName: "无声视频.mp4",
          byteSize: (await readFile(fixture)).byteLength
        },
        mediaProbe,
        blobRoot,
        gateway: { invoke } as unknown as ModelGateway,
        dataPolicy: "local_only",
        ffmpeg
      });

      expect(videoProbeHasAudioStream(mediaProbe)).toBe(false);
      expect(result).toMatchObject({ status: "skipped", reason: "VIDEO_AUDIO_STREAM_MISSING" });
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains the video evidence when the ASR provider disappears after probing", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-video-asr-test-"));
    try {
      const fixture = await createMp4Fixture(directory, true);
      const blobRoot = path.join(directory, "blobs");
      const blobStore = new LocalBlobStore(blobRoot);
      const blobUri = await blobStore.putImmutable(
        `space/resource/${versionId}/provider-gone.mp4`,
        await readFile(fixture)
      );
      const parser = createWorkerResourceParser({
        blobStore,
        blobRoot,
        python,
        parserScript,
        ffprobe,
        ffmpeg
      });
      const mediaProbe = await parser.parseVersion({
        id: versionId,
        mimeType: "video/mp4",
        blobUri
      });

      const result = await transcribeVideoAudioTrack({
        version: {
          id: versionId,
          mimeType: "video/mp4",
          blobUri,
          originalName: "课堂视频.mp4",
          byteSize: (await readFile(fixture)).byteLength
        },
        mediaProbe,
        blobRoot,
        gateway: {
          invoke: vi.fn(async () => {
            throw new Error("MODEL_CAPABILITY_UNAVAILABLE");
          })
        } as unknown as ModelGateway,
        dataPolicy: "local_only",
        ffmpeg
      });

      expect(result).toMatchObject({ status: "skipped", reason: "VIDEO_ASR_PROVIDER_UNAVAILABLE" });
      expect(result.output).toEqual(mediaProbe);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
