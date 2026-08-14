import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalBlobStore } from "@wknowledge/blob-store";
import type { ModelGateway } from "@wknowledge/model-gateway";
import { transcribeAudioVersion } from "../src/audio-transcription.js";
import { evaluateLocatorCases } from "../src/locator-evaluation.js";

const versionId = "11111111-1111-4111-8111-111111111111";

function mediaProbe() {
  return {
    document: {
      schemaVersion: 1 as const,
      resourceVersionId: versionId,
      nodes: [
        {
          schemaVersion: 1 as const,
          id: "media-metadata-1",
          kind: "paragraph" as const,
          content: "媒体元数据已提取；尚未生成转写或画面理解。",
          order: 0,
          locator: {
            type: "audio" as const,
            resourceVersionId: versionId,
            startMs: 0,
            endMs: 1_250
          },
          metadata: { durationMs: 1_250 }
        }
      ]
    },
    manifest: {
      schemaVersion: 1 as const,
      parserId: "wknowledge-python-media-probe",
      parserVersion: "1.0.0",
      runtime: "python" as const,
      mimeType: "audio/wav",
      resourceVersionId: versionId,
      generatedAt: new Date().toISOString()
    }
  };
}

describe("Worker audio transcription", () => {
  it("turns a Worker-owned probed audio Blob into a traceable transcript node", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-asr-worker-"));
    try {
      const blobStore = new LocalBlobStore(path.join(directory, "blobs"));
      const blobUri = await blobStore.putImmutable(
        `space/resource/${versionId}/source.wav`,
        Buffer.from("wav")
      );
      const invoke = vi.fn(async () => ({
        providerId: "local-asr",
        model: "whisper",
        output: "这是可回查的转写文本。",
        durationMs: 42
      }));
      const result = await transcribeAudioVersion({
        version: {
          id: versionId,
          mimeType: "audio/wav",
          blobUri,
          originalName: "课堂录音.wav",
          byteSize: 3
        },
        mediaProbe: mediaProbe(),
        blobStore,
        gateway: { invoke } as unknown as ModelGateway,
        dataPolicy: "local_only"
      });

      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({ capability: "speech_to_text", dataPolicy: "local_only" })
      );
      expect(result.manifest.parserId).toBe("wknowledge-worker-asr");
      expect(result.document.nodes.at(-1)).toMatchObject({
        kind: "transcript",
        content: "这是可回查的转写文本。",
        locator: { type: "audio", resourceVersionId: versionId, startMs: 0, endMs: 1_250 },
        metadata: { providerId: "local-asr", model: "whisper" }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires the immutable audio version to have passed media probing first", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-asr-worker-"));
    try {
      const blobStore = new LocalBlobStore(path.join(directory, "blobs"));
      const blobUri = await blobStore.putImmutable(
        `space/resource/${versionId}/source.wav`,
        Buffer.from("wav")
      );
      await expect(
        transcribeAudioVersion({
          version: {
            id: versionId,
            mimeType: "audio/wav",
            blobUri,
            originalName: "lesson.wav",
            byteSize: 3
          },
          mediaProbe: {
            ...mediaProbe(),
            document: { ...mediaProbe().document, nodes: [] }
          },
          blobStore,
          gateway: { invoke: vi.fn() } as unknown as ModelGateway,
          dataPolicy: "local_only"
        })
      ).rejects.toThrow("ASR_MEDIA_PROBE_REQUIRED");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects oversized audio from version metadata before reading the Blob or calling a Provider", async () => {
    const read = vi.fn(async () => {
      throw new Error("BLOB_READ_SHOULD_NOT_HAPPEN");
    });
    const invoke = vi.fn();
    const oversizedVersion = {
      id: versionId,
      mimeType: "audio/wav",
      blobUri: "local://space/resource/source.wav",
      originalName: "oversized.wav",
      byteSize: 25 * 1024 * 1024 + 1
    };

    await expect(
      transcribeAudioVersion({
        version: oversizedVersion,
        mediaProbe: mediaProbe(),
        blobStore: { read } as unknown as LocalBlobStore,
        gateway: { invoke } as unknown as ModelGateway,
        dataPolicy: "local_only"
      })
    ).rejects.toThrow("ASR_SOURCE_SIZE_LIMIT");

    expect(read).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses valid provider segments as separate time-bounded transcript nodes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-asr-worker-"));
    try {
      const blobStore = new LocalBlobStore(path.join(directory, "blobs"));
      const blobUri = await blobStore.putImmutable(
        `space/resource/${versionId}/source.wav`,
        Buffer.from("wav")
      );
      const result = await transcribeAudioVersion({
        version: {
          id: versionId,
          mimeType: "audio/wav",
          blobUri,
          originalName: "课堂录音.wav",
          byteSize: 3
        },
        mediaProbe: mediaProbe(),
        blobStore,
        gateway: {
          invoke: vi.fn(async () => ({
            providerId: "local-asr",
            model: "whisper",
            output: {
              text: "第一段。第二段。",
              segments: [
                { startMs: 0, endMs: 600, text: "第一段。" },
                { startMs: 600, endMs: 1_250, text: "第二段。" }
              ]
            },
            durationMs: 42
          }))
        } as unknown as ModelGateway,
        dataPolicy: "local_only"
      });
      expect(result.document.nodes.slice(1)).toMatchObject([
        {
          id: "transcript-1",
          content: "第一段。",
          locator: { type: "audio", startMs: 0, endMs: 600 },
          metadata: { segmentation: "provider_segments" }
        },
        {
          id: "transcript-2",
          content: "第二段。",
          locator: { type: "audio", startMs: 600, endMs: 1_250 },
          metadata: { segmentation: "provider_segments" }
        }
      ]);
      const report = evaluateLocatorCases(
        [
          {
            id: "audio-segment-one",
            type: "audio",
            expected: { type: "audio", resourceVersionId: versionId, startMs: 0, endMs: 600 },
            actual: result.document.nodes.find(({ id }) => id === "transcript-1")?.locator
          },
          {
            id: "audio-segment-two",
            type: "audio",
            expected: { type: "audio", resourceVersionId: versionId, startMs: 600, endMs: 1_250 },
            actual: result.document.nodes.find(({ id }) => id === "transcript-2")?.locator
          }
        ],
        { evaluatedAt: "2026-08-14T00:00:00.000Z", minimumAccuracy: 1 }
      );
      expect(report).toMatchObject({ evaluatedCount: 2, matchedCount: 2, accuracy: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses one explicitly coarse node when provider segments are out of media bounds", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-asr-worker-"));
    try {
      const blobStore = new LocalBlobStore(path.join(directory, "blobs"));
      const blobUri = await blobStore.putImmutable(
        `space/resource/${versionId}/source.wav`,
        Buffer.from("wav")
      );
      const result = await transcribeAudioVersion({
        version: {
          id: versionId,
          mimeType: "audio/wav",
          blobUri,
          originalName: "课堂录音.wav",
          byteSize: 3
        },
        mediaProbe: mediaProbe(),
        blobStore,
        gateway: {
          invoke: vi.fn(async () => ({
            providerId: "local-asr",
            model: "whisper",
            output: { text: "完整转写。", segments: [{ startMs: 0, endMs: 1_500, text: "越界" }] },
            durationMs: 42
          }))
        } as unknown as ModelGateway,
        dataPolicy: "local_only"
      });
      expect(result.document.nodes.slice(1)).toMatchObject([
        {
          id: "transcript-1",
          content: "完整转写。",
          locator: { type: "audio", startMs: 0, endMs: 1_250 },
          metadata: { segmentation: "whole_media_provider_without_timestamps" }
        }
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
