import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LocalBlobStore } from "@wknowledge/blob-store";
import { createWorkerResourceParser } from "../src/resource-parser.js";
import { extractVideoKeyframes } from "../src/video-keyframes.js";
import { extractVideoKeyframeOcr } from "../src/video-keyframe-ocr.js";

const execFileAsync = promisify(execFile);
const python = process.env.WKNOWLEDGE_PYTHON ?? "python3";
const ffmpeg = process.env.WKNOWLEDGE_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.WKNOWLEDGE_FFPROBE ?? "ffprobe";
const parserScript = path.resolve(
  import.meta.dirname,
  "../../../runtimes/python/parse_document.py"
);
const versionId = "11111111-1111-4111-8111-111111111111";

async function createMp4Fixture(directory: string): Promise<string> {
  const file = path.join(directory, "silent.mp4");
  await execFileAsync(ffmpeg, [
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:d=1.25",
    "-c:v",
    "mpeg4",
    "-y",
    file
  ]);
  return file;
}

async function createTextMp4Fixture(directory: string): Promise<string> {
  const imageFile = path.join(directory, "frame.jpg");
  const file = path.join(directory, "text.mp4");
  await execFileAsync(python, [
    "-c",
    [
      "from PIL import Image, ImageDraw, ImageFont",
      "image = Image.new('RGB', (640, 360), 'white')",
      "draw = ImageDraw.Draw(image)",
      "font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 80)",
      "draw.text((40, 120), 'LEARN', fill='black', font=font)",
      `image.save(${JSON.stringify(imageFile)}, 'JPEG')`
    ].join("; ")
  ]);
  await execFileAsync(ffmpeg, [
    "-loop",
    "1",
    "-i",
    imageFile,
    "-t",
    "1.25",
    "-c:v",
    "mpeg4",
    "-y",
    file
  ]);
  return file;
}

describe("Worker video keyframe extraction", () => {
  it("extracts bounded JPEG frames from a Worker-owned silent MP4 without model calls", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-video-keyframes-"));
    try {
      const fixture = await createMp4Fixture(directory);
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
      const result = await extractVideoKeyframes({
        version: {
          id: versionId,
          mimeType: "video/mp4",
          blobUri,
          byteSize: (await readFile(fixture)).byteLength
        },
        mediaProbe,
        blobRoot,
        ffmpeg
      });
      expect(result.status).toBe("completed");
      if (result.status === "completed") {
        expect(result.assets).toHaveLength(1);
        expect(result.assets[0]).toMatchObject({ path: "keyframes/frame-001.jpg" });
        expect(Array.from(result.assets[0]?.bytes.subarray(0, 3) ?? [])).toEqual([
          0xff, 0xd8, 0xff
        ]);
        expect(result.output.document.nodes.at(-1)).toMatchObject({
          id: "keyframe-001",
          kind: "image",
          locator: { type: "video", resourceVersionId: versionId, startMs: 0, endMs: 1 },
          metadata: {
            source: "video_keyframe",
            assetPath: "keyframes/frame-001.jpg",
            contentRole: "original_frame"
          }
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a source URI outside the Worker blob root", async () => {
    await expect(
      extractVideoKeyframes({
        version: {
          id: versionId,
          mimeType: "video/mp4",
          blobUri: "local://../outside.mp4",
          byteSize: 1
        },
        mediaProbe: {
          document: {
            schemaVersion: 1,
            resourceVersionId: versionId,
            nodes: [
              {
                schemaVersion: 1,
                id: "media-metadata-1",
                kind: "paragraph",
                content: "媒体元数据",
                order: 0,
                locator: { type: "video", resourceVersionId: versionId, startMs: 0, endMs: 1_000 },
                metadata: { videoStreams: [{ codec: "mpeg4" }] }
              }
            ]
          },
          manifest: {
            schemaVersion: 1,
            parserId: "test-parser",
            parserVersion: "1.0.0",
            runtime: "node",
            mimeType: "video/mp4",
            resourceVersionId: versionId,
            generatedAt: "2026-08-14T00:00:00.000Z"
          }
        },
        blobRoot: "/tmp/wknowledge-test",
        ffmpeg
      })
    ).rejects.toThrow("BLOB_PATH_OUTSIDE_ROOT");
  });

  it("skips an invalid media probe without a video stream", async () => {
    const result = await extractVideoKeyframes({
      version: { id: versionId, mimeType: "video/mp4", blobUri: "local://valid.mp4", byteSize: 1 },
      mediaProbe: {
        document: {
          schemaVersion: 1,
          resourceVersionId: versionId,
          nodes: [
            {
              schemaVersion: 1,
              id: "media-metadata-1",
              kind: "paragraph",
              content: "媒体元数据",
              order: 0,
              locator: { type: "video", resourceVersionId: versionId, startMs: 0, endMs: 1_000 },
              metadata: { videoStreams: [] }
            }
          ]
        },
        manifest: {
          schemaVersion: 1,
          parserId: "test-parser",
          parserVersion: "1.0.0",
          runtime: "node",
          mimeType: "video/mp4",
          resourceVersionId: versionId,
          generatedAt: "2026-08-14T00:00:00.000Z"
        }
      },
      blobRoot: "/tmp/wknowledge-test",
      ffmpeg
    });
    expect(result).toMatchObject({ status: "skipped", reason: "VIDEO_STREAM_MISSING" });
  });

  it("adds time-bound OCR lines for text in a Worker-extracted keyframe", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-video-keyframe-ocr-"));
    try {
      const fixture = await createTextMp4Fixture(directory);
      const blobRoot = path.join(directory, "blobs");
      const blobStore = new LocalBlobStore(blobRoot);
      const blobUri = await blobStore.putImmutable(
        `space/resource/${versionId}/text.mp4`,
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
      const keyframes = await extractVideoKeyframes({
        version: {
          id: versionId,
          mimeType: "video/mp4",
          blobUri,
          byteSize: (await readFile(fixture)).byteLength
        },
        mediaProbe,
        blobRoot,
        ffmpeg
      });
      expect(keyframes.status).toBe("completed");
      if (keyframes.status !== "completed") return;
      const result = await extractVideoKeyframeOcr({
        keyframes: keyframes.output,
        assets: keyframes.assets,
        python,
        parserScript,
        tesseract: "tesseract"
      });
      expect(result.status).toBe("completed");
      if (result.status !== "completed") return;
      const lines = result.output.document.nodes.filter(
        ({ metadata }) => metadata.source === "video_keyframe_ocr"
      );
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.map(({ content }) => content).join(" ")).toMatch(/LEARN/i);
      expect(lines[0]).toMatchObject({
        kind: "image",
        locator: { type: "video", resourceVersionId: versionId, startMs: 0, endMs: 1 },
        metadata: {
          source: "video_keyframe_ocr",
          contentRole: "ocr_line",
          frameId: "keyframe-001",
          assetPath: "keyframes/frame-001.jpg",
          sampledAtMs: 0,
          bbox: expect.any(Array)
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the extracted keyframe unchanged when no readable frame text exists", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-video-keyframe-ocr-empty-"));
    try {
      const fixture = await createMp4Fixture(directory);
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
      const keyframes = await extractVideoKeyframes({
        version: {
          id: versionId,
          mimeType: "video/mp4",
          blobUri,
          byteSize: (await readFile(fixture)).byteLength
        },
        mediaProbe,
        blobRoot,
        ffmpeg
      });
      expect(keyframes.status).toBe("completed");
      if (keyframes.status !== "completed") return;
      const result = await extractVideoKeyframeOcr({
        keyframes: keyframes.output,
        assets: keyframes.assets,
        python,
        parserScript,
        tesseract: "tesseract"
      });
      expect(result).toMatchObject({ status: "completed", lineCount: 0, frameCount: 1 });
      if (result.status === "completed")
        expect(result.output.document.nodes).toEqual(keyframes.output.document.nodes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps all extracted keyframes when the local OCR runtime is unavailable", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "wknowledge-video-keyframe-ocr-missing-")
    );
    try {
      const fixture = await createMp4Fixture(directory);
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
      const keyframes = await extractVideoKeyframes({
        version: {
          id: versionId,
          mimeType: "video/mp4",
          blobUri,
          byteSize: (await readFile(fixture)).byteLength
        },
        mediaProbe,
        blobRoot,
        ffmpeg
      });
      expect(keyframes.status).toBe("completed");
      if (keyframes.status !== "completed") return;
      const result = await extractVideoKeyframeOcr({
        keyframes: keyframes.output,
        assets: keyframes.assets,
        python: "wknowledge-python-not-installed",
        parserScript,
        tesseract: "tesseract"
      });
      expect(result).toMatchObject({ status: "skipped", reason: "VIDEO_KEYFRAME_OCR_UNAVAILABLE" });
      if (result.status === "skipped") expect(result.output).toEqual(keyframes.output);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
