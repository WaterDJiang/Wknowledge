import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function parseFixture(file: string, mimeType: string) {
  const { stdout } = await execFileAsync(python, [
    parserScript,
    "--input",
    file,
    "--mime",
    mimeType,
    "--version-id",
    versionId
  ]);
  return parserOutputSchema.parse(JSON.parse(stdout));
}

describe("sheet range parser", () => {
  it("parses quoted CSV rows into non-empty sheet ranges", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-csv-range-"));
    try {
      const fixture = path.join(directory, "learning.csv");
      await writeFile(fixture, '主题,说明\nAI,"有,引号"\n\n学习,复盘\n', "utf8");
      const output = await parseFixture(fixture, "text/csv");
      expect(output.manifest).toMatchObject({
        parserId: "wknowledge-python-document",
        runtime: "python",
        mimeType: "text/csv"
      });
      expect(output.document.nodes).toHaveLength(2);
      expect(output.document.nodes.map((node) => node.locator)).toEqual([
        { type: "sheet", resourceVersionId: versionId, sheet: "CSV", range: "A1:B2" },
        { type: "sheet", resourceVersionId: versionId, sheet: "CSV", range: "A4:B4" }
      ]);
      expect(output.document.nodes[0]).toMatchObject({
        content: "主题\t说明\nAI\t有,引号",
        metadata: { delimiter: ",", parser: "python-csv", rowStart: 1, rowEnd: 2 }
      });
      const report = evaluateLocatorCases(
        [
          {
            id: "csv-first-range",
            type: "sheet",
            expected: { type: "sheet", resourceVersionId: versionId, sheet: "CSV", range: "A1:B2" },
            actual: output.document.nodes[0]?.locator
          },
          {
            id: "csv-second-range",
            type: "sheet",
            expected: { type: "sheet", resourceVersionId: versionId, sheet: "CSV", range: "A4:B4" },
            actual: output.document.nodes[1]?.locator
          }
        ],
        { evaluatedAt: "2026-08-14T00:00:00.000Z", minimumAccuracy: 1 }
      );
      expect(report).toMatchObject({ evaluatedCount: 2, matchedCount: 2, accuracy: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a CSV whose row count exceeds the parser budget before producing nodes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-csv-dimension-limit-"));
    try {
      const fixture = path.join(directory, "sparse-limit.csv");
      await writeFile(fixture, `${"\n".repeat(50_000)}only-cell\n`, "utf8");
      await expect(parseFixture(fixture, "text/csv")).rejects.toThrow("CSV_DIMENSION_LIMIT");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves XLSX sheet ranges, cached values and formula text without evaluating formulas", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-xlsx-range-"));
    try {
      const fixture = path.join(directory, "study.xlsx");
      await execFileAsync(python, [
        "-c",
        [
          "from openpyxl import Workbook",
          "book = Workbook()",
          "sheet = book.active",
          "sheet.title = '进度'",
          "sheet.append(['项目', '分钟', '合计'])",
          "sheet.append(['阅读', 30, '=B2*2'])",
          "sheet.append([])",
          "sheet.append(['练习', 15, '=B4*2'])",
          "other = book.create_sheet('笔记')",
          "other.append(['结论'])",
          "other.append(['保持证据链'])",
          `book.save(${JSON.stringify(fixture)})`
        ].join("; ")
      ]);
      const output = await parseFixture(
        fixture,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      expect(output.document.nodes.map((node) => node.locator)).toEqual([
        { type: "sheet", resourceVersionId: versionId, sheet: "进度", range: "A1:C2" },
        { type: "sheet", resourceVersionId: versionId, sheet: "进度", range: "A4:C4" },
        { type: "sheet", resourceVersionId: versionId, sheet: "笔记", range: "A1:A2" }
      ]);
      expect(output.document.nodes[0]).toMatchObject({
        content: "项目\t分钟\t合计\n阅读\t30\t",
        metadata: {
          parser: "python-xlsx",
          formulas: [{ cell: "C2", formula: "=B2*2" }]
        }
      });
      expect(output.document.nodes[2]?.content).toContain("保持证据链");
      const report = evaluateLocatorCases(
        [
          {
            id: "xlsx-progress-first-range",
            type: "sheet",
            expected: {
              type: "sheet",
              resourceVersionId: versionId,
              sheet: "进度",
              range: "A1:C2"
            },
            actual: output.document.nodes[0]?.locator
          },
          {
            id: "xlsx-progress-second-range",
            type: "sheet",
            expected: {
              type: "sheet",
              resourceVersionId: versionId,
              sheet: "进度",
              range: "A4:C4"
            },
            actual: output.document.nodes[1]?.locator
          },
          {
            id: "xlsx-notes-range",
            type: "sheet",
            expected: {
              type: "sheet",
              resourceVersionId: versionId,
              sheet: "笔记",
              range: "A1:A2"
            },
            actual: output.document.nodes[2]?.locator
          }
        ],
        { evaluatedAt: "2026-08-14T00:00:00.000Z", minimumAccuracy: 1 }
      );
      expect(report).toMatchObject({ evaluatedCount: 3, matchedCount: 3, accuracy: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a sparse XLSX whose declared row dimension exceeds the parser budget before producing nodes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-xlsx-dimension-limit-"));
    try {
      const fixture = path.join(directory, "sparse-limit.xlsx");
      await execFileAsync(python, [
        "-c",
        [
          "from openpyxl import Workbook",
          "book = Workbook()",
          "sheet = book.active",
          "sheet.title = '超限范围'",
          "sheet.cell(50001, 1, 'only-cell')",
          `book.save(${JSON.stringify(fixture)})`
        ].join("; ")
      ]);
      await expect(
        parseFixture(fixture, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      ).rejects.toThrow("XLSX_DIMENSION_LIMIT");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("splits long sheets and marks oversized formula summaries instead of growing an unbounded node", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-xlsx-bounds-"));
    try {
      const fixture = path.join(directory, "bounded.xlsx");
      await execFileAsync(python, [
        "-c",
        [
          "from openpyxl import Workbook",
          "book = Workbook()",
          "sheet = book.active",
          "sheet.title = '范围'",
          "[(sheet.cell(row, 1, row), sheet.cell(row, 2, '=A' + str(row) + '*2')) for row in range(1, 202)]",
          "sheet.cell(202, 3, '=' + 'A1+' * 5000 + '1')",
          `book.save(${JSON.stringify(fixture)})`
        ].join("; ")
      ]);
      const output = await parseFixture(
        fixture,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      expect(output.document.nodes).toHaveLength(2);
      expect(output.document.nodes.map((node) => node.locator)).toEqual([
        { type: "sheet", resourceVersionId: versionId, sheet: "范围", range: "A1:B200" },
        { type: "sheet", resourceVersionId: versionId, sheet: "范围", range: "A201:C202" }
      ]);
      expect(output.document.nodes[1]).toMatchObject({
        metadata: { formulaSummaryTruncated: true }
      });
      const formulas = output.document.nodes[1]?.metadata.formulas as Array<{ formula: string }>;
      expect(formulas.at(-1)?.formula.length).toBeLessThanOrEqual(4_097);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
