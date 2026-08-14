import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LocalBlobStore } from "@wknowledge/blob-store";
import { parserOutputSchema } from "@wknowledge/contracts";
import { createWorkerResourceParser } from "../src/resource-parser.js";

const execFileAsync = promisify(execFile);
const python = process.env.WKNOWLEDGE_PYTHON ?? "python3";
const ffmpeg = process.env.WKNOWLEDGE_FFMPEG ?? "ffmpeg";
const ffprobe = process.env.WKNOWLEDGE_FFPROBE ?? "ffprobe";
const parserScript = path.resolve(
  import.meta.dirname,
  "../../../runtimes/python/parse_document.py"
);
const versionId = "11111111-1111-4111-8111-111111111111";

async function createWavFixture(directory: string): Promise<string> {
  const file = path.join(directory, "tone.wav");
  await execFileAsync(ffmpeg, [
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1.25",
    "-y",
    file
  ]);
  return file;
}

async function createMp4Fixture(directory: string): Promise<string> {
  const file = path.join(directory, "frame.mp4");
  await execFileAsync(ffmpeg, [
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:d=1.25",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1.25",
    "-shortest",
    "-c:v",
    "mpeg4",
    "-c:a",
    "aac",
    "-y",
    file
  ]);
  return file;
}

async function createMp4WithSubtitleFixture(directory: string): Promise<string> {
  const subtitle = path.join(directory, "caption.srt");
  const file = path.join(directory, "captioned.mp4");
  await writeFile(subtitle, "1\n00:00:00,000 --> 00:00:01,000\nThis is fixture text.\n");
  await execFileAsync(ffmpeg, [
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x180:d=1.25",
    "-f",
    "srt",
    "-i",
    subtitle,
    "-map",
    "0:v:0",
    "-map",
    "1:s:0",
    "-metadata:s:s:0",
    "language=eng",
    "-metadata:s:s:0",
    "title=Fixture captions",
    "-c:v",
    "mpeg4",
    "-c:s",
    "mov_text",
    "-y",
    file
  ]);
  return file;
}

describe("media probe Python CLI", () => {
  it("emits a time-bounded audio metadata node without claiming transcript output", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-media-probe-"));
    try {
      const fixture = await createWavFixture(directory);
      const { stdout } = await execFileAsync(python, [
        parserScript,
        "--input",
        fixture,
        "--mime",
        "audio/wav",
        "--version-id",
        versionId,
        "--ffprobe",
        ffprobe
      ]);
      const output = parserOutputSchema.parse(JSON.parse(stdout));
      expect(output.manifest).toMatchObject({
        parserId: "wknowledge-python-media-probe",
        runtime: "python",
        mimeType: "audio/wav",
        resourceVersionId: versionId
      });
      expect(output.document.nodes).toHaveLength(1);
      expect(output.document.nodes[0]).toMatchObject({
        id: "media-metadata-1",
        locator: { type: "audio", resourceVersionId: versionId, startMs: 0 },
        metadata: { kind: "audio", audioStreams: [{ codec: expect.any(String) }] }
      });
      expect(output.document.nodes[0]!.locator).toMatchObject({ endMs: expect.any(Number) });
      expect(output.document.nodes[0]!.content).toContain("尚未生成转写");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects media MIME when the container does not contain the required stream", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-media-probe-"));
    try {
      const fixture = await createWavFixture(directory);
      await expect(
        execFileAsync(python, [
          parserScript,
          "--input",
          fixture,
          "--mime",
          "video/mp4",
          "--version-id",
          versionId,
          "--ffprobe",
          ffprobe
        ])
      ).rejects.toMatchObject({ stderr: expect.stringContaining("MEDIA_PROBE_STREAM_MISSING") });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("emits a video locator and does not claim frame understanding", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-video-probe-"));
    try {
      const fixture = await createMp4Fixture(directory);
      const { stdout } = await execFileAsync(python, [
        parserScript,
        "--input",
        fixture,
        "--mime",
        "video/mp4",
        "--version-id",
        versionId,
        "--ffprobe",
        ffprobe
      ]);
      const output = parserOutputSchema.parse(JSON.parse(stdout));
      expect(output.document.nodes[0]).toMatchObject({
        locator: { type: "video", resourceVersionId: versionId, startMs: 0 },
        metadata: {
          kind: "video",
          audioStreams: [
            { index: expect.any(Number), codec: expect.any(String), default: expect.any(Boolean) }
          ],
          videoStreams: [{ codec: expect.any(String), width: 320, height: 180 }]
        }
      });
      expect(output.document.nodes[0]?.metadata).toMatchObject({ subtitleStreams: [] });
      expect(output.document.nodes[0]?.content).toContain("尚未生成转写或画面理解");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("extracts embedded text subtitles as time-bounded video evidence without claiming visual understanding", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-video-probe-"));
    try {
      const fixture = await createMp4WithSubtitleFixture(directory);
      const { stdout } = await execFileAsync(python, [
        parserScript,
        "--input",
        fixture,
        "--mime",
        "video/mp4",
        "--version-id",
        versionId,
        "--ffprobe",
        ffprobe,
        "--ffmpeg",
        ffmpeg
      ]);
      const output = parserOutputSchema.parse(JSON.parse(stdout));
      expect(output.document.nodes[0]).toMatchObject({
        metadata: {
          subtitleStreams: [
            {
              index: expect.any(Number),
              codec: "mov_text",
              language: "eng",
              title: null
            }
          ]
        }
      });
      expect(output.document.nodes).toHaveLength(2);
      expect(output.document.nodes[1]).toMatchObject({
        id: "subtitle-1-1",
        kind: "transcript",
        content: "This is fixture text.",
        locator: { type: "video", resourceVersionId: versionId, startMs: 0, endMs: 1_000 },
        metadata: {
          source: "embedded_subtitle",
          streamIndex: 1,
          codec: "mov_text",
          language: "eng"
        }
      });
      expect(output.document.nodes[0]?.content).toContain("尚未生成转写或画面理解");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("selects the media probe from a Worker-owned local audio Blob", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-media-worker-"));
    try {
      const fixture = await createWavFixture(directory);
      const blobRoot = path.join(directory, "blobs");
      const blobStore = new LocalBlobStore(blobRoot);
      const blobUri = await blobStore.putImmutable(
        "space-a/resource-a/version-a/source.wav",
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

      const output = await parser.parseVersion({
        id: versionId,
        mimeType: "audio/wav",
        blobUri
      });

      expect(output.manifest.parserId).toBe("wknowledge-python-media-probe");
      expect(output.document.nodes[0]?.locator).toMatchObject({
        type: "audio",
        resourceVersionId: versionId,
        startMs: 0
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("extracts embedded subtitle evidence only from a Worker-owned local video Blob", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-video-worker-"));
    try {
      const fixture = await createMp4WithSubtitleFixture(directory);
      const blobRoot = path.join(directory, "blobs");
      const blobStore = new LocalBlobStore(blobRoot);
      const blobUri = await blobStore.putImmutable(
        "space-a/resource-a/version-a/source.mp4",
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

      const output = await parser.parseVersion({
        id: versionId,
        mimeType: "video/mp4",
        blobUri
      });

      expect(output.manifest).toMatchObject({
        parserId: "wknowledge-python-media-probe",
        mimeType: "video/mp4"
      });
      expect(output.document.nodes).toHaveLength(2);
      expect(output.document.nodes[1]).toMatchObject({
        content: "This is fixture text.",
        locator: { type: "video", resourceVersionId: versionId, startMs: 0, endMs: 1_000 }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
