import { describe, expect, it } from "vitest";
import type { BlobStore } from "@wknowledge/blob-store";
import { createWorkerResourceParser } from "../src/resource-parser.js";

const versionId = "11111111-1111-4111-8111-111111111111";

function textParserFor(bytes: Uint8Array) {
  let reads = 0;
  const parser = createWorkerResourceParser({
    blobStore: {
      read: async () => {
        reads += 1;
        return bytes;
      }
    } as unknown as BlobStore,
    blobRoot: "/tmp/wknowledge-parser-limits",
    python: "python3",
    parserScript: "parse_document.py",
    ffprobe: "ffprobe",
    ffmpeg: "ffmpeg"
  });
  return { parser, readCount: () => reads };
}

describe("Worker text parser resource limits", () => {
  it("rejects source text larger than 8 MiB before UTF-8 decoding", async () => {
    const { parser, readCount } = textParserFor(Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));

    await expect(
      parser.parseVersion({
        id: versionId,
        mimeType: "text/plain",
        blobUri: "local://space/resource/source.txt"
      })
    ).rejects.toThrow("TEXT_SOURCE_SIZE_LIMIT");

    expect(readCount()).toBe(1);
  });

  it("rejects text that would create more than 10,000 evidence nodes", async () => {
    const content = Buffer.from("paragraph\n\n".repeat(10_001), "utf8");
    const { parser } = textParserFor(content);

    await expect(
      parser.parseVersion({
        id: versionId,
        mimeType: "text/markdown",
        blobUri: "local://space/resource/source.md"
      })
    ).rejects.toThrow("TEXT_NODE_LIMIT");
  });
});
