import { describe, expect, it } from "vitest";
import type { ModelProvider, ModelRequest } from "@wknowledge/model-gateway";
import { ModelGateway } from "@wknowledge/model-gateway";
import { describeVideoKeyframes } from "../src/video-keyframe-vision.js";

const versionId = "11111111-1111-4111-8111-111111111111";

function keyframes() {
  return {
    document: {
      schemaVersion: 1 as const,
      resourceVersionId: versionId,
      nodes: [
        {
          schemaVersion: 1 as const,
          id: "media-metadata-1",
          kind: "paragraph" as const,
          content: "视频元数据",
          order: 0,
          locator: {
            type: "video" as const,
            resourceVersionId: versionId,
            startMs: 0,
            endMs: 1_000
          },
          metadata: { kind: "video" }
        },
        {
          schemaVersion: 1 as const,
          id: "keyframe-001",
          kind: "image" as const,
          title: "视频关键帧 1",
          content: "原始视频画面帧 · 0 秒",
          order: 1,
          locator: { type: "video" as const, resourceVersionId: versionId, startMs: 0, endMs: 1 },
          metadata: {
            source: "video_keyframe",
            contentRole: "original_frame",
            sampledAtMs: 0,
            assetPath: "keyframes/frame-001.jpg"
          }
        }
      ]
    },
    manifest: {
      schemaVersion: 1 as const,
      parserId: "wknowledge-worker-video-keyframes",
      parserVersion: "1.0.0",
      runtime: "node" as const,
      mimeType: "video/mp4",
      resourceVersionId: versionId,
      generatedAt: "2026-08-14T00:00:00.000Z"
    }
  };
}

function visionGateway(input: {
  location?: "local" | "cloud";
  output?: unknown;
  requests?: ModelRequest[];
}) {
  const gateway = new ModelGateway();
  const provider: ModelProvider = {
    id: "vision-provider",
    location: input.location ?? "local",
    capabilities: new Set(["vision"]),
    healthcheck: async () => true,
    invoke: async (request) => {
      input.requests?.push(request);
      return {
        providerId: "vision-provider",
        model: "vision-model",
        output:
          input.output ?? JSON.stringify({ description: "蓝色背景上的课程标题", confidence: 0.82 }),
        durationMs: 23
      };
    }
  };
  gateway.register(provider);
  return gateway;
}

describe("Worker video keyframe vision", () => {
  it("writes a bounded, time-located visual description from only a Worker keyframe", async () => {
    const requests: ModelRequest[] = [];
    const result = await describeVideoKeyframes({
      keyframes: keyframes(),
      assets: [{ path: "keyframes/frame-001.jpg", bytes: Buffer.from([0xff, 0xd8, 0xff]) }],
      gateway: visionGateway({ requests }),
      dataPolicy: "local_only"
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.descriptionCount).toBe(1);
    expect(result.output.document.nodes.at(-1)).toMatchObject({
      id: "keyframe-001-vision",
      kind: "image",
      content: "蓝色背景上的课程标题",
      locator: { type: "video", resourceVersionId: versionId, startMs: 0, endMs: 1 },
      metadata: {
        source: "video_keyframe_vision",
        sourceMarking: "ai_completed",
        contentRole: "visual_description",
        frameId: "keyframe-001",
        assetPath: "keyframes/frame-001.jpg",
        providerId: "vision-provider",
        model: "vision-model",
        confidence: 0.82
      }
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ capability: "vision", purpose: "video_understanding" });
    expect(JSON.stringify(requests[0]?.payload)).not.toContain("local://");
  });

  it("skips without partial descriptions when the vision response is not the required JSON", async () => {
    const source = keyframes();
    const result = await describeVideoKeyframes({
      keyframes: source,
      assets: [{ path: "keyframes/frame-001.jpg", bytes: Buffer.from([0xff, 0xd8, 0xff]) }],
      gateway: visionGateway({ output: "图片里有一张幻灯片" }),
      dataPolicy: "local_only"
    });

    expect(result).toEqual({
      status: "skipped",
      output: source,
      reason: "VIDEO_VISION_UNAVAILABLE"
    });
  });

  it("does not send a frame to a cloud vision provider in redaction-required spaces", async () => {
    const requests: ModelRequest[] = [];
    const source = keyframes();
    const result = await describeVideoKeyframes({
      keyframes: source,
      assets: [{ path: "keyframes/frame-001.jpg", bytes: Buffer.from([0xff, 0xd8, 0xff]) }],
      gateway: visionGateway({ location: "cloud", requests }),
      dataPolicy: "cloud_allowed_after_redaction"
    });

    expect(result).toEqual({
      status: "skipped",
      output: source,
      reason: "VIDEO_VISION_UNAVAILABLE"
    });
    expect(requests).toHaveLength(0);
  });
});
