import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parserOutputSchema } from "@wknowledge/contracts";
import { evaluateLocatorCases } from "../src/locator-evaluation";

const execFileAsync = promisify(execFile);
const python = process.env.WKNOWLEDGE_PYTHON ?? "python3";
const parserScript = path.resolve(
  import.meta.dirname,
  "../../../runtimes/python/parse_document.py"
);
const versionId = "11111111-1111-4111-8111-111111111111";

async function parseFixture(file: string) {
  const { stdout } = await execFileAsync(python, [
    parserScript,
    "--input",
    file,
    "--mime",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "--version-id",
    versionId
  ]);
  return parserOutputSchema.parse(JSON.parse(stdout));
}

describe("slide shape parser", () => {
  it("emits distinct text Shape, table and notes nodes with immutable slide locators", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-slide-shapes-"));
    try {
      const fixture = path.join(directory, "learning.pptx");
      await execFileAsync(python, [
        "-c",
        [
          "from pptx import Presentation",
          "from pptx.util import Inches",
          "book = Presentation()",
          "slide = book.slides.add_slide(book.slide_layouts[6])",
          "title = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1))",
          "title.text = '学习计划'",
          "table = slide.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(5), Inches(1)).table",
          "table.cell(0, 0).text = '单元'",
          "table.cell(0, 1).text = '状态'",
          "table.cell(1, 0).text = '原文'",
          "table.cell(1, 1).text = '完成'",
          "slide.notes_slide.notes_text_frame.text = '讲师备注：强调来源定位。'",
          "second = book.slides.add_slide(book.slide_layouts[6])",
          "body = second.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1))",
          "body.text = '第二页内容'",
          `book.save(${JSON.stringify(fixture)})`
        ].join("; ")
      ]);
      const output = await parseFixture(fixture);
      expect(output.manifest).toMatchObject({
        parserId: "wknowledge-python-document",
        runtime: "python"
      });
      expect(output.document.nodes).toHaveLength(4);
      const shapeNodes = output.document.nodes.filter((node) => node.locator.shapeId);
      expect(shapeNodes).toHaveLength(3);
      expect(shapeNodes[0]).toMatchObject({
        content: "学习计划",
        locator: {
          type: "slide",
          resourceVersionId: versionId,
          slide: 1,
          shapeId: expect.any(String)
        }
      });
      expect(shapeNodes[1]).toMatchObject({
        content: "单元\t状态\n原文\t完成",
        metadata: { isTable: true }
      });
      expect(
        output.document.nodes.find((node) => node.metadata.contentRole === "notes")
      ).toMatchObject({
        content: "讲师备注：强调来源定位。",
        locator: { type: "slide", resourceVersionId: versionId, slide: 1 }
      });
      expect(shapeNodes[2]).toMatchObject({
        content: "第二页内容",
        locator: { type: "slide", resourceVersionId: versionId, slide: 2 }
      });
      const report = evaluateLocatorCases(
        [
          {
            id: "slide-one-title",
            type: "slide",
            expected: { type: "slide", resourceVersionId: versionId, slide: 1, shapeId: "2" },
            actual: output.document.nodes.find(({ content }) => content === "学习计划")?.locator
          },
          {
            id: "slide-one-table",
            type: "slide",
            expected: { type: "slide", resourceVersionId: versionId, slide: 1, shapeId: "3" },
            actual: output.document.nodes.find(
              ({ content }) => content === "单元\t状态\n原文\t完成"
            )?.locator
          },
          {
            id: "slide-one-notes",
            type: "slide",
            expected: { type: "slide", resourceVersionId: versionId, slide: 1 },
            actual: output.document.nodes.find(({ metadata }) => metadata.contentRole === "notes")
              ?.locator
          },
          {
            id: "slide-two-body",
            type: "slide",
            expected: { type: "slide", resourceVersionId: versionId, slide: 2, shapeId: "2" },
            actual: output.document.nodes.find(({ content }) => content === "第二页内容")?.locator
          }
        ],
        { evaluatedAt: "2026-08-14T00:00:00.000Z", minimumAccuracy: 1 }
      );
      expect(report).toMatchObject({ evaluatedCount: 4, matchedCount: 4, accuracy: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks a long Shape as truncated without creating visual claims", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-slide-bounds-"));
    try {
      const fixture = path.join(directory, "bounded.pptx");
      await execFileAsync(python, [
        "-c",
        [
          "from pptx import Presentation",
          "from pptx.util import Inches",
          "book = Presentation()",
          "slide = book.slides.add_slide(book.slide_layouts[6])",
          "shape = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1))",
          "shape.text = '证据' * 20000",
          `book.save(${JSON.stringify(fixture)})`
        ].join("; ")
      ]);
      const output = await parseFixture(fixture);
      expect(output.document.nodes).toHaveLength(1);
      expect(output.document.nodes[0]).toMatchObject({ metadata: { textTruncated: true } });
      expect(Buffer.byteLength(output.document.nodes[0]!.content, "utf8")).toBeLessThanOrEqual(
        32 * 1024 + 3
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
