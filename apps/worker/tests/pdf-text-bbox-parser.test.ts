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
    "application/pdf",
    "--version-id",
    versionId
  ]);
  return parserOutputSchema.parse(JSON.parse(stdout));
}

describe("PDF text bbox parser", () => {
  it("emits stable page and point bbox nodes for native PDF text", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-pdf-bbox-"));
    try {
      const fixture = path.join(directory, "learning.pdf");
      await execFileAsync(python, [
        "-c",
        [
          "from reportlab.pdfgen import canvas",
          `output = canvas.Canvas(${JSON.stringify(fixture)})`,
          "output.drawString(72, 720, 'Learning Plan')",
          "output.drawString(72, 680, 'Practice Review')",
          "output.showPage()",
          "output.drawString(72, 720, 'Second Page')",
          "output.save()"
        ].join("; ")
      ]);
      const output = await parseFixture(fixture);
      expect(output.manifest).toMatchObject({
        parserId: "wknowledge-python-document",
        runtime: "python",
        mimeType: "application/pdf"
      });
      expect(output.document.nodes.map((node) => node.content).join(" ")).toMatch(/Learning Plan/);
      expect(output.document.nodes.map((node) => node.content).join(" ")).toMatch(/Second Page/);
      expect(output.document.nodes).toHaveLength(3);
      for (const node of output.document.nodes) {
        expect(node).toMatchObject({
          kind: "paragraph",
          locator: { type: "pdf", resourceVersionId: versionId, bbox: expect.any(Array) },
          metadata: { coordinateUnit: "pdf_point", textTruncated: false }
        });
        const bbox = node.locator.type === "pdf" ? node.locator.bbox : undefined;
        expect(bbox).toHaveLength(4);
        expect(bbox![2]).toBeGreaterThan(bbox![0]);
        expect(bbox![3]).toBeGreaterThan(bbox![1]);
      }
      const report = evaluateLocatorCases(
        [
          {
            id: "learning-plan",
            type: "pdf",
            expected: {
              type: "pdf",
              resourceVersionId: versionId,
              page: 1,
              bbox: [72, 108, 147, 126]
            },
            actual: output.document.nodes.find(({ content }) => content === "Learning Plan")
              ?.locator,
            bboxIouThreshold: 0.8
          },
          {
            id: "second-page",
            type: "pdf",
            expected: {
              type: "pdf",
              resourceVersionId: versionId,
              page: 2,
              bbox: [72, 108, 145, 126]
            },
            actual: output.document.nodes.find(({ content }) => content === "Second Page")?.locator,
            bboxIouThreshold: 0.8
          }
        ],
        { evaluatedAt: "2026-08-14T00:00:00.000Z", minimumAccuracy: 1 }
      );
      expect(report).toMatchObject({ evaluatedCount: 2, matchedCount: 2, accuracy: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not create evidence nodes for a blank PDF page", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-pdf-blank-"));
    try {
      const fixture = path.join(directory, "blank.pdf");
      await execFileAsync(python, [
        "-c",
        [
          "from reportlab.pdfgen import canvas",
          `output = canvas.Canvas(${JSON.stringify(fixture)})`,
          "output.showPage()",
          "output.save()"
        ].join("; ")
      ]);
      await expect(parseFixture(fixture)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a PDF with more than 500 pages before extracting text blocks", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-pdf-page-limit-"));
    try {
      const fixture = path.join(directory, "many-pages.pdf");
      await execFileAsync(python, [
        "-c",
        [
          "from reportlab.pdfgen import canvas",
          `output = canvas.Canvas(${JSON.stringify(fixture)})`,
          "[output.showPage() for _ in range(501)]",
          "output.save()"
        ].join("; ")
      ]);
      await expect(parseFixture(fixture)).rejects.toMatchObject({
        stderr: expect.stringContaining("PDF_PAGE_LIMIT")
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
