import { describe, expect, it } from "vitest";
import { videoKeyframeItems } from "../app/workspace/video-keyframes";

const versionId = "11111111-1111-4111-8111-111111111111";

describe("video keyframe filtering", () => {
  it("only returns same-version frame assets in the requested video interval", () => {
    expect(
      videoKeyframeItems(
        [
          {
            schemaVersion: 1,
            id: "keyframe-001",
            kind: "image",
            content: "帧",
            order: 0,
            locator: { type: "video", resourceVersionId: versionId, startMs: 1_000, endMs: 1_001 },
            metadata: { source: "video_keyframe", assetPath: "keyframes/frame-001.jpg" }
          },
          {
            schemaVersion: 1,
            id: "wrong-source",
            kind: "image",
            content: "非帧",
            order: 1,
            locator: { type: "video", resourceVersionId: versionId, startMs: 1_500, endMs: 1_501 },
            metadata: { source: "image_ocr", assetPath: "keyframes/frame-002.jpg" }
          },
          {
            schemaVersion: 1,
            id: "keyframe-001-ocr-001",
            kind: "image",
            content: "每日练习",
            order: 2,
            locator: { type: "video", resourceVersionId: versionId, startMs: 1_000, endMs: 1_001 },
            metadata: {
              source: "video_keyframe_ocr",
              contentRole: "ocr_line",
              frameId: "keyframe-001",
              bbox: [20, 30, 120, 60]
            }
          },
          {
            schemaVersion: 1,
            id: "keyframe-001-ocr-forged",
            kind: "image",
            content: "不应显示",
            order: 3,
            locator: { type: "video", resourceVersionId: versionId, startMs: 1_000, endMs: 1_001 },
            metadata: {
              source: "video_keyframe_ocr",
              contentRole: "ocr_line",
              frameId: "keyframe-001",
              bbox: [20, 30, "forged", 60]
            }
          },
          {
            schemaVersion: 1,
            id: "keyframe-001-vision",
            kind: "image",
            content: "AI 识别到一页蓝色课程封面。",
            order: 4,
            locator: { type: "video", resourceVersionId: versionId, startMs: 1_000, endMs: 1_001 },
            metadata: {
              source: "video_keyframe_vision",
              sourceMarking: "ai_completed",
              contentRole: "visual_description",
              frameId: "keyframe-001",
              assetPath: "keyframes/frame-001.jpg",
              confidence: 0.82
            }
          },
          {
            schemaVersion: 1,
            id: "keyframe-001-vision-forged",
            kind: "image",
            content: "不应显示",
            order: 5,
            locator: { type: "video", resourceVersionId: versionId, startMs: 1_000, endMs: 1_001 },
            metadata: {
              source: "video_keyframe_vision",
              sourceMarking: "extracted",
              contentRole: "visual_description",
              frameId: "keyframe-001",
              assetPath: "keyframes/frame-001.jpg"
            }
          },
          {
            schemaVersion: 1,
            id: "other-version",
            kind: "image",
            content: "旧版本",
            order: 6,
            locator: {
              type: "video",
              resourceVersionId: "22222222-2222-4222-8222-222222222222",
              startMs: 1_500,
              endMs: 1_501
            },
            metadata: { source: "video_keyframe", assetPath: "keyframes/frame-003.jpg" }
          }
        ],
        { type: "video", resourceVersionId: versionId, startMs: 500, endMs: 2_000 }
      )
    ).toEqual([
      {
        id: "keyframe-001",
        startMs: 1_000,
        endMs: 1_001,
        ocrLines: [{ id: "keyframe-001-ocr-001", content: "每日练习", bbox: [20, 30, 120, 60] }],
        visualDescription: { content: "AI 识别到一页蓝色课程封面。", confidence: 0.82 }
      }
    ]);
  });
});
