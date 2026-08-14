import { describe, expect, it } from "vitest";
import { isMediaLocator, isMediaPreviewSupported } from "../app/workspace/media-source-player";

const versionId = "11111111-1111-4111-8111-111111111111";

describe("source media preview policy", () => {
  it("only enables playback when a media locator and MIME type agree", () => {
    const audio = {
      type: "audio" as const,
      resourceVersionId: versionId,
      startMs: 0,
      endMs: 1_250
    };
    const video = {
      type: "video" as const,
      resourceVersionId: versionId,
      startMs: 250,
      endMs: 1_000
    };

    expect(isMediaLocator(audio)).toBe(true);
    expect(isMediaPreviewSupported(audio, "audio/wav")).toBe(true);
    expect(isMediaPreviewSupported(video, "video/mp4")).toBe(true);
    expect(isMediaPreviewSupported(audio, "video/mp4")).toBe(false);
    expect(isMediaPreviewSupported(video, "audio/mpeg")).toBe(false);
  });

  it("does not treat non-media source locators as playable", () => {
    const pdf = { type: "pdf" as const, resourceVersionId: versionId, page: 1 };

    expect(isMediaLocator(pdf)).toBe(false);
    expect(isMediaPreviewSupported(pdf, "application/pdf")).toBe(false);
  });
});
