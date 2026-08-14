import { describe, expect, it } from "vitest";
import { mediaMatchesLocator, sourceContentDisposition } from "../lib/source-content-policy";

describe("source content response policy", () => {
  it("permits inline media only for its matching source locator type", () => {
    expect(mediaMatchesLocator("audio/wav", "audio")).toBe(true);
    expect(mediaMatchesLocator("video/mp4", "video")).toBe(true);
    expect(mediaMatchesLocator("audio/wav", "video")).toBe(false);
    expect(mediaMatchesLocator("video/mp4", "document")).toBe(false);

    expect(sourceContentDisposition("audio/wav", 2, "audio")).toContain("inline");
    expect(sourceContentDisposition("audio/wav", 2, "video")).toContain("attachment");
  });
});
