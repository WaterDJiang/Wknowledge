import { describe, expect, it } from "vitest";
import type { CompiledDocument } from "@wknowledge/contracts";
import { selectImagePreview } from "../lib/image-preview";

const versionId = "11111111-1111-4111-8111-111111111111";
const document: CompiledDocument = {
  schemaVersion: 1,
  resourceVersionId: versionId,
  nodes: [
    {
      schemaVersion: 1,
      id: "image-ocr-line-1",
      kind: "image",
      title: "图片文字第 1 行",
      content: "学习计划",
      order: 0,
      locator: { type: "image", resourceVersionId: versionId, bbox: [40, 20, 240, 80] },
      metadata: { imageWidth: 800, imageHeight: 300, contentRole: "ocr_line", textTruncated: false }
    },
    {
      schemaVersion: 1,
      id: "image-ocr-line-2",
      kind: "image",
      title: "图片文字第 2 行",
      content: "练习回顾",
      order: 1,
      locator: { type: "image", resourceVersionId: versionId, bbox: [40, 120, 240, 180] },
      metadata: { imageWidth: 800, imageHeight: 300, contentRole: "ocr_line", textTruncated: false }
    }
  ]
};

describe("selectImagePreview", () => {
  it("returns only the exact published OCR region", () => {
    expect(
      selectImagePreview(document, {
        type: "image",
        resourceVersionId: versionId,
        bbox: [40, 120, 240, 180]
      })
    ).toMatchObject({ content: "练习回顾", metadata: { imageWidth: 800, imageHeight: 300 } });
  });

  it("does not fall back to a different or whole-image locator", () => {
    expect(
      selectImagePreview(document, {
        type: "image",
        resourceVersionId: versionId,
        bbox: [0, 0, 800, 300]
      })
    ).toBeNull();
    expect(
      selectImagePreview(document, { type: "image", resourceVersionId: versionId })
    ).toBeNull();
  });
});
