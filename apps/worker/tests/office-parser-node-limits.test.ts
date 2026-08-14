import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parserOutputSchema } from "@wknowledge/contracts";

const execFileAsync = promisify(execFile);
const python = process.env.WKNOWLEDGE_PYTHON ?? "python3";
const parserScript = path.resolve(
  import.meta.dirname,
  "../../../runtimes/python/parse_document.py"
);
const versionId = "11111111-1111-4111-8111-111111111111";

function parseFixture(file: string, mimeType: string) {
  return execFileAsync(python, [
    parserScript,
    "--input",
    file,
    "--mime",
    mimeType,
    "--version-id",
    versionId
  ]);
}

describe("Office parser node limits", () => {
  it("preserves normal DOCX hierarchy and marks one oversized paragraph as truncated", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-docx-node-bounds-"));
    try {
      const fixture = path.join(directory, "bounded.docx");
      await execFileAsync(python, [
        "-c",
        [
          "from docx import Document",
          "book = Document()",
          "book.add_heading('学习目标', level=1)",
          "book.add_paragraph('证据' * 20000)",
          `book.save(${JSON.stringify(fixture)})`
        ].join("; ")
      ]);

      const { stdout } = await parseFixture(
        fixture,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      const output = parserOutputSchema.parse(JSON.parse(stdout));
      expect(output.document.nodes).toHaveLength(2);
      expect(output.document.nodes[1]).toMatchObject({
        parentId: "paragraph-1",
        metadata: { textTruncated: true }
      });
      expect(Buffer.byteLength(output.document.nodes[1]!.content, "utf8")).toBeLessThanOrEqual(
        32 * 1024 + 3
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects DOCX documents beyond the paragraph budget before emitting nodes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-docx-node-limit-"));
    try {
      const fixture = path.join(directory, "too-many-paragraphs.docx");
      await execFileAsync(python, [
        "-c",
        [
          "from docx import Document",
          "book = Document()",
          "[book.add_paragraph('evidence') for _ in range(10001)]",
          `book.save(${JSON.stringify(fixture)})`
        ].join("; ")
      ]);

      await expect(
        parseFixture(
          fixture,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
      ).rejects.toThrow("DOCX_NODE_LIMIT");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects PPTX documents beyond the slide budget before emitting nodes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-pptx-node-limit-"));
    try {
      const fixture = path.join(directory, "too-many-slides.pptx");
      await execFileAsync(python, [
        "-c",
        [
          "from pptx import Presentation",
          "book = Presentation()",
          "layout = book.slide_layouts[6]",
          "[book.slides.add_slide(layout) for _ in range(501)]",
          `book.save(${JSON.stringify(fixture)})`
        ].join("; ")
      ]);

      await expect(
        parseFixture(
          fixture,
          "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        )
      ).rejects.toThrow("PPTX_NODE_LIMIT");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
