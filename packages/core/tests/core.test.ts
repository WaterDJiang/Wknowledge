import { describe, expect, it } from "vitest";
import { uploadResource, type JobQueue } from "../src/index";
import type { BlobStore } from "@wknowledge/blob-store";

describe("MVP scope guard", () => {
  it("does not load a vector database client", () => {
    const dependencies = Object.keys(
      (globalThis as { dependencies?: Record<string, string> }).dependencies ?? {}
    );
    expect(dependencies.some((name) => /pinecone|qdrant|milvus|weaviate/i.test(name))).toBe(false);
  });

  it("rejects media types until their processing pipeline is available", async () => {
    const blobStore = {} as BlobStore;
    const queue = {} as JobQueue;
    await expect(
      uploadResource(
        {
          spaceId: "11111111-1111-4111-8111-111111111111",
          userId: "22222222-2222-4222-8222-222222222222",
          name: "lesson.mp3",
          mimeType: "audio/mpeg",
          bytes: new Uint8Array([1]),
          compileProfile: "knowledge"
        },
        blobStore,
        queue
      )
    ).rejects.toThrow("UPLOAD_MIME_UNSUPPORTED");
  });
});
