import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LocalBlobStore } from "@wknowledge/blob-store";
import { renderPdfPages } from "../src/pdf-page-renderer.js";

const execFileAsync = promisify(execFile);
const python = process.env.WKNOWLEDGE_PYTHON ?? "python3";
const rendererScript = path.resolve(
  import.meta.dirname,
  "../../../runtimes/python/render_pdf_pages.py"
);

describe("Worker PDF page rendering", () => {
  it("renders a Worker-owned PDF into bounded historical page assets", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-pdf-pages-"));
    try {
      const fixture = path.join(directory, "source.pdf");
      await execFileAsync(python, [
        "-c",
        [
          "from reportlab.pdfgen import canvas",
          `output = canvas.Canvas(${JSON.stringify(fixture)})`,
          "output.drawString(72, 720, 'Learning Plan')",
          "output.showPage()",
          "output.drawString(72, 720, 'Second Page')",
          "output.save()"
        ].join("; ")
      ]);
      const blobRoot = path.join(directory, "blobs");
      const blobStore = new LocalBlobStore(blobRoot);
      const blobUri = await blobStore.putImmutable(
        "space/resource/version/source.pdf",
        await readFile(fixture)
      );
      const result = await renderPdfPages({
        version: { mimeType: "application/pdf", blobUri },
        blobRoot,
        python,
        script: rendererScript
      });
      expect(result.manifest.pages).toHaveLength(2);
      expect(result.assets.map(({ path: assetPath }) => assetPath)).toEqual([
        "pdf-pages/page-001.png",
        "pdf-pages/page-002.png"
      ]);
      expect(Array.from(result.assets[0]?.bytes.subarray(0, 8) ?? [])).toEqual([
        137, 80, 78, 71, 13, 10, 26, 10
      ]);
      expect(result.manifest.pages[0]).toMatchObject({
        page: 1,
        width: expect.any(Number),
        height: expect.any(Number),
        pdfPointWidth: expect.any(Number),
        pdfPointHeight: expect.any(Number)
      });
      expect(result.manifest.pages[0]!.pdfPointWidth).toBeGreaterThan(0);
      expect(result.manifest.pages[0]!.pdfPointHeight).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a source URI outside the Worker blob root", async () => {
    await expect(
      renderPdfPages({
        version: { mimeType: "application/pdf", blobUri: "local://../outside.pdf" },
        blobRoot: "/tmp/wknowledge-pdf-page-test",
        python,
        script: rendererScript
      })
    ).rejects.toThrow("BLOB_PATH_OUTSIDE_ROOT");
  });
});
