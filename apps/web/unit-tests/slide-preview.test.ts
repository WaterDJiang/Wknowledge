import { describe, expect, it } from "vitest";
import type { CompiledDocument } from "@wknowledge/contracts";
import { selectSlidePreview } from "../lib/slide-preview";

const versionId = "11111111-1111-4111-8111-111111111111";
const document: CompiledDocument = {
  schemaVersion: 1,
  resourceVersionId: versionId,
  nodes: [
    {
      schemaVersion: 1,
      id: "slide-1-shape-2",
      kind: "slide",
      title: "第 1 页 · Shape 2",
      content: "学习目标",
      order: 0,
      locator: { type: "slide", resourceVersionId: versionId, slide: 1, shapeId: "2" },
      metadata: { slideNumber: 1, shapeId: "2", contentRole: "shape", textTruncated: false }
    },
    {
      schemaVersion: 1,
      id: "slide-1-shape-3",
      kind: "slide",
      title: "第 1 页 · Shape 3",
      content: "完成练习",
      order: 1,
      locator: { type: "slide", resourceVersionId: versionId, slide: 1, shapeId: "3" },
      metadata: { slideNumber: 1, shapeId: "3", contentRole: "shape", textTruncated: true }
    },
    {
      schemaVersion: 1,
      id: "slide-1-notes",
      kind: "slide",
      title: "第 1 页 · 备注",
      content: "讲师提示",
      order: 2,
      locator: { type: "slide", resourceVersionId: versionId, slide: 1 },
      metadata: { slideNumber: 1, contentRole: "notes", textTruncated: false }
    },
    {
      schemaVersion: 1,
      id: "slide-2-shape-2",
      kind: "slide",
      title: "第 2 页 · Shape 2",
      content: "范围外页面",
      order: 3,
      locator: { type: "slide", resourceVersionId: versionId, slide: 2, shapeId: "2" },
      metadata: { slideNumber: 2, shapeId: "2", contentRole: "shape", textTruncated: false }
    }
  ]
};

describe("selectSlidePreview", () => {
  it("returns only the requested published Shape", () => {
    expect(
      selectSlidePreview(document, {
        type: "slide",
        resourceVersionId: versionId,
        slide: 1,
        shapeId: "3"
      })
    ).toMatchObject({
      items: [{ shapeId: "3", role: "shape", content: "完成练习", textTruncated: true }]
    });
  });

  it("returns the page's Shape and notes content only for a slide locator", () => {
    expect(
      selectSlidePreview(document, {
        type: "slide",
        resourceVersionId: versionId,
        slide: 1
      })
    ).toMatchObject({
      items: [
        { shapeId: "2", role: "shape", content: "学习目标" },
        { shapeId: "3", role: "shape", content: "完成练习" },
        { shapeId: null, role: "notes", content: "讲师提示" }
      ]
    });
  });

  it("does not fall back to another slide or Shape", () => {
    expect(
      selectSlidePreview(document, {
        type: "slide",
        resourceVersionId: versionId,
        slide: 1,
        shapeId: "99"
      })
    ).toBeNull();
    expect(
      selectSlidePreview(document, {
        type: "slide",
        resourceVersionId: versionId,
        slide: 3
      })
    ).toBeNull();
  });
});
