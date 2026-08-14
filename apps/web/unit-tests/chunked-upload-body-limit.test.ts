import { describe, expect, it } from "vitest";
import { readChunkedUploadPartBytes } from "../lib/chunked-upload-api";

describe("chunked upload request body limit", () => {
  it("reads an exact-size upload part from multiple body chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3, 4]));
        controller.close();
      }
    });

    await expect(readChunkedUploadPartBytes(body, 4)).resolves.toEqual(
      Uint8Array.from([1, 2, 3, 4])
    );
  });

  it("rejects an oversized part without trusting a missing content-length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3, 4, 5]));
        controller.close();
      }
    });

    await expect(readChunkedUploadPartBytes(body, 4)).rejects.toThrow("UPLOAD_PART_SIZE_INVALID");
  });

  it("rejects a part request without a readable body", async () => {
    await expect(readChunkedUploadPartBytes(null, 4)).rejects.toThrow("UPLOAD_PART_BODY_REQUIRED");
  });
});
