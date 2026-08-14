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
    "image/png",
    "--version-id",
    versionId
  ]);
  return parserOutputSchema.parse(JSON.parse(stdout));
}

describe("image OCR parser", () => {
  it("emits bounded OCR line nodes with immutable image regions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-image-ocr-"));
    try {
      const fixture = path.join(directory, "learning.png");
      await execFileAsync(python, [
        "-c",
        [
          "from PIL import Image, ImageDraw, ImageFont",
          "image = Image.new('RGB', (800, 300), 'white')",
          "draw = ImageDraw.Draw(image)",
          "font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Unicode.ttf', 56)",
          "draw.text((40, 45), 'Learning Plan', fill='black', font=font)",
          "draw.text((40, 155), 'Practice Review', fill='black', font=font)",
          `image.save(${JSON.stringify(fixture)})`
        ].join("; ")
      ]);
      const output = await parseFixture(fixture);
      expect(output.manifest).toMatchObject({
        parserId: "wknowledge-python-image-ocr",
        runtime: "python",
        mimeType: "image/png"
      });
      expect(output.document.nodes.length).toBeGreaterThanOrEqual(2);
      expect(output.document.nodes.map((node) => node.content).join(" ")).toMatch(/Learning Plan/i);
      expect(output.document.nodes.map((node) => node.content).join(" ")).toMatch(
        /Practice Review/i
      );
      for (const node of output.document.nodes) {
        expect(node).toMatchObject({
          kind: "image",
          locator: { type: "image", resourceVersionId: versionId, bbox: expect.any(Array) },
          metadata: { contentRole: "ocr_line", imageWidth: 800, imageHeight: 300 }
        });
        const bbox = node.locator.type === "image" ? node.locator.bbox : undefined;
        expect(bbox).toBeDefined();
        expect(bbox![0]).toBeGreaterThanOrEqual(0);
        expect(bbox![1]).toBeGreaterThanOrEqual(0);
        expect(bbox![2]).toBeLessThanOrEqual(800);
        expect(bbox![3]).toBeLessThanOrEqual(300);
      }
      const report = evaluateLocatorCases(
        [
          {
            id: "learning-plan-region",
            type: "image",
            expected: {
              type: "image",
              resourceVersionId: versionId,
              bbox: [40, 60, 390, 120]
            },
            actual: output.document.nodes.find(({ content }) => /Learning Plan/i.test(content))
              ?.locator,
            bboxIouThreshold: 0.8
          },
          {
            id: "practice-review-region",
            type: "image",
            expected: {
              type: "image",
              resourceVersionId: versionId,
              bbox: [40, 170, 450, 220]
            },
            actual: output.document.nodes.find(({ content }) => /Practice Review/i.test(content))
              ?.locator,
            bboxIouThreshold: 0.75
          }
        ],
        { evaluatedAt: "2026-08-14T00:00:00.000Z", minimumAccuracy: 1 }
      );
      expect(report).toMatchObject({ evaluatedCount: 2, matchedCount: 2, accuracy: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses to claim OCR content for an image with no text", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-image-empty-"));
    try {
      const fixture = path.join(directory, "empty.png");
      await execFileAsync(python, [
        "-c",
        [
          "from PIL import Image",
          "image = Image.new('RGB', (120, 80), 'white')",
          `image.save(${JSON.stringify(fixture)})`
        ].join("; ")
      ]);
      await expect(parseFixture(fixture)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
