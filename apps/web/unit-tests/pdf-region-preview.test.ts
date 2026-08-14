import { describe, expect, it } from "vitest";
import type { CompiledDocument } from "@wknowledge/contracts";
import { parsePdfPageManifest, selectPdfRegionPreview } from "../lib/pdf-region-preview";

const versionId = "11111111-1111-4111-8111-111111111111";
const document: CompiledDocument = {
  schemaVersion: 1,
  resourceVersionId: versionId,
  nodes: [
    {
      schemaVersion: 1,
      id: "page-1-block-1",
      kind: "paragraph",
      content: "学习计划",
      order: 0,
      locator: { type: "pdf", resourceVersionId: versionId, page: 1, bbox: [72, 108, 147, 126] },
      metadata: { coordinateUnit: "pdf_point", textTruncated: false }
    }
  ]
};
const manifest = parsePdfPageManifest({
  schemaVersion: 1,
  pages: [
    {
      page: 1,
      path: "pdf-pages/page-001.png",
      width: 1224,
      height: 1584,
      pdfPointWidth: 612,
      pdfPointHeight: 792
    }
  ]
});

describe("selectPdfRegionPreview", () => {
  it("returns only an exact same-page published native-text bbox", () => {
    expect(
      selectPdfRegionPreview(document, manifest, {
        type: "pdf",
        resourceVersionId: versionId,
        page: 1,
        bbox: [72, 108, 147, 126]
      })
    ).toMatchObject({ content: "学习计划", page: { pdfPointWidth: 612, pdfPointHeight: 792 } });
  });

  it("does not fall back for a different bbox or a bbox outside the page", () => {
    expect(
      selectPdfRegionPreview(document, manifest, {
        type: "pdf",
        resourceVersionId: versionId,
        page: 1,
        bbox: [72, 108, 148, 126]
      })
    ).toBeNull();
    expect(
      selectPdfRegionPreview(document, manifest, {
        type: "pdf",
        resourceVersionId: versionId,
        page: 1,
        bbox: [72, 108, 700, 126]
      })
    ).toBeNull();
  });
});
