import { describe, expect, it } from "vitest";
import type { CompiledDocument } from "@wknowledge/contracts";
import { selectSheetPreview } from "../lib/sheet-preview";

const versionId = "11111111-1111-4111-8111-111111111111";
const document: CompiledDocument = {
  schemaVersion: 1,
  resourceVersionId: versionId,
  nodes: [
    {
      schemaVersion: 1,
      id: "sheet-1-range-1",
      kind: "table",
      title: "进度 · A1:B2",
      content: "项目\t分钟\n阅读\t30",
      order: 0,
      locator: { type: "sheet", resourceVersionId: versionId, sheet: "进度", range: "A1:B2" },
      metadata: {
        rowStart: 1,
        rowEnd: 2,
        columnCount: 2,
        formulas: [],
        formulaSummaryTruncated: false
      }
    },
    {
      schemaVersion: 1,
      id: "sheet-1-range-2",
      kind: "table",
      title: "进度 · A4:B4",
      content: "练习\t15",
      order: 1,
      locator: { type: "sheet", resourceVersionId: versionId, sheet: "进度", range: "A4:B4" },
      metadata: {
        rowStart: 4,
        rowEnd: 4,
        columnCount: 2,
        formulas: [],
        formulaSummaryTruncated: false
      }
    }
  ]
};

describe("selectSheetPreview", () => {
  it("returns only the exact published range", () => {
    expect(
      selectSheetPreview(document, {
        type: "sheet",
        resourceVersionId: versionId,
        sheet: "进度",
        range: "A4:B4"
      })
    ).toMatchObject({ content: "练习\t15", metadata: { rowStart: 4, rowEnd: 4 } });
  });

  it("does not fall back to another range or sheet", () => {
    expect(
      selectSheetPreview(document, {
        type: "sheet",
        resourceVersionId: versionId,
        sheet: "进度",
        range: "A1:B4"
      })
    ).toBeNull();
    expect(
      selectSheetPreview(document, {
        type: "sheet",
        resourceVersionId: versionId,
        sheet: "其他工作表",
        range: "A1:B2"
      })
    ).toBeNull();
  });
});
