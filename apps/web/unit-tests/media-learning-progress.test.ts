import { describe, expect, it } from "vitest";
import {
  MEDIA_PROGRESS_MINIMUM_DELTA_MS,
  mediaProgressPosition,
  shouldSyncMediaProgress
} from "../app/workspace/media-learning-progress";

describe("media learning progress", () => {
  it("constrains a browser playback position to the fixed source location", () => {
    expect(mediaProgressPosition(2, 5_000, 20_000)).toBe(5_000);
    expect(mediaProgressPosition(12.345, 5_000, 20_000)).toBe(12_345);
    expect(mediaProgressPosition(22, 5_000, 20_000)).toBe(20_000);
  });

  it("rejects invalid browser values and malformed source time ranges", () => {
    expect(mediaProgressPosition(Number.NaN, 0, 1_000)).toBeNull();
    expect(mediaProgressPosition(1, -1, 1_000)).toBeNull();
    expect(mediaProgressPosition(1, 1_000, 0)).toBeNull();
  });

  it("only schedules periodic syncs after a meaningful time delta unless forced", () => {
    expect(shouldSyncMediaProgress(null, 5_000)).toBe(true);
    expect(shouldSyncMediaProgress(5_000, 5_000)).toBe(false);
    expect(shouldSyncMediaProgress(5_000, 5_000 + MEDIA_PROGRESS_MINIMUM_DELTA_MS - 1)).toBe(false);
    expect(shouldSyncMediaProgress(5_000, 5_000 + MEDIA_PROGRESS_MINIMUM_DELTA_MS)).toBe(true);
    expect(shouldSyncMediaProgress(5_000, 5_001, true)).toBe(true);
  });
});
