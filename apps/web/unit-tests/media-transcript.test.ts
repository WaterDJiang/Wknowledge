import { describe, expect, it } from "vitest";
import { activeMediaTranscriptId, mediaTranscriptItems } from "../app/workspace/media-transcript";

const versionId = "11111111-1111-4111-8111-111111111111";

describe("media transcript filtering", () => {
  it("returns same-version transcript segments that overlap the source range", () => {
    const items = mediaTranscriptItems(
      [
        {
          schemaVersion: 1,
          id: "before",
          kind: "transcript",
          content: "范围之前",
          order: 0,
          locator: { type: "video", resourceVersionId: versionId, startMs: 0, endMs: 1_000 },
          metadata: {}
        },
        {
          schemaVersion: 1,
          id: "inside",
          kind: "transcript",
          content: "当前字幕",
          order: 1,
          locator: { type: "video", resourceVersionId: versionId, startMs: 1_500, endMs: 2_500 },
          metadata: { sourceKind: "embedded_subtitle" }
        },
        {
          schemaVersion: 1,
          id: "wrong-type",
          kind: "transcript",
          content: "错误媒体类型",
          order: 2,
          locator: { type: "audio", resourceVersionId: versionId, startMs: 1_500, endMs: 2_500 },
          metadata: {}
        }
      ],
      { type: "video", resourceVersionId: versionId, startMs: 1_000, endMs: 3_000 }
    );
    expect(items).toEqual([
      {
        id: "inside",
        startMs: 1_500,
        endMs: 2_500,
        content: "当前字幕",
        sourceKind: "embedded_subtitle"
      }
    ]);
  });

  it("does not return other versions or transcript segments outside the source locator", () => {
    expect(
      mediaTranscriptItems(
        [
          {
            schemaVersion: 1,
            id: "other-version",
            kind: "transcript",
            content: "旧版本",
            order: 0,
            locator: {
              type: "audio",
              resourceVersionId: "22222222-2222-4222-8222-222222222222",
              startMs: 1_000,
              endMs: 2_000
            },
            metadata: {}
          }
        ],
        { type: "audio", resourceVersionId: versionId, startMs: 1_000, endMs: 2_000 }
      )
    ).toEqual([]);
  });

  it("marks only the transcript segment containing the current playback position", () => {
    const items = [
      { id: "first", startMs: 1_000, endMs: 2_000, content: "第一段", sourceKind: "asr" },
      { id: "second", startMs: 2_000, endMs: 3_000, content: "第二段", sourceKind: "asr" }
    ];
    expect(activeMediaTranscriptId(items, 1_500)).toBe("first");
    expect(activeMediaTranscriptId(items, 2_000)).toBe("second");
    expect(activeMediaTranscriptId(items, 3_000)).toBeNull();
    expect(activeMediaTranscriptId(items, null)).toBeNull();
  });
});
