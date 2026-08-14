import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pdfPageManifestSchema, type PdfPageManifest } from "@wknowledge/contracts";

const execFileAsync = promisify(execFile);

async function localBlobSourcePath(blobRoot: string, blobUri: string): Promise<string> {
  if (!blobUri.startsWith("local://")) throw new Error("PDF_PAGE_RENDER_REQUIRES_LOCAL_BLOB");
  const relative = path.posix.normalize(blobUri.slice("local://".length));
  if (relative.startsWith("../") || relative === ".." || path.posix.isAbsolute(relative))
    throw new Error("BLOB_PATH_OUTSIDE_ROOT");
  const sourcePath = path.join(blobRoot, relative);
  if (!(await lstat(sourcePath)).isFile()) throw new Error("PDF_PAGE_RENDER_SOURCE_UNAVAILABLE");
  return sourcePath;
}

export async function renderPdfPages(input: {
  version: { mimeType: string; blobUri: string };
  blobRoot: string;
  python: string;
  script: string;
  signal?: AbortSignal;
}): Promise<{ assets: Array<{ path: string; bytes: Uint8Array }>; manifest: PdfPageManifest }> {
  if (input.version.mimeType !== "application/pdf")
    throw new Error("PDF_PAGE_RENDER_MIME_UNSUPPORTED");
  const directory = await mkdtemp(path.join(os.tmpdir(), "wknowledge-pdf-pages-"));
  try {
    const source = await localBlobSourcePath(input.blobRoot, input.version.blobUri);
    if ((await stat(source)).size === 0) throw new Error("PDF_PAGE_RENDER_SOURCE_EMPTY");
    const outputDirectory = path.join(directory, "pdf-pages");
    try {
      await execFileAsync(
        input.python,
        [input.script, "--input", source, "--output-dir", outputDirectory],
        {
          timeout: 5 * 60 * 1_000,
          signal: input.signal
        }
      );
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new Error("PDF_PAGE_RENDER_FAILED");
    }
    const manifest = pdfPageManifestSchema.parse(
      JSON.parse(await readFile(path.join(outputDirectory, "manifest.json"), "utf8"))
    );
    const expected = new Set(manifest.pages.map((page) => path.posix.basename(page.path)));
    const names = await readdir(outputDirectory);
    if (names.some((name) => name !== "manifest.json" && !expected.has(name)))
      throw new Error("PDF_PAGE_RENDER_OUTPUT_INVALID");
    const assets = await Promise.all(
      manifest.pages.map(async (page) => ({
        path: page.path,
        bytes: await readFile(path.join(outputDirectory, path.posix.basename(page.path)))
      }))
    );
    if (assets.some((asset) => !asset.bytes.byteLength || asset.bytes.byteLength > 8 * 1024 * 1024))
      throw new Error("PDF_PAGE_RENDER_OUTPUT_INVALID");
    return { assets, manifest };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
