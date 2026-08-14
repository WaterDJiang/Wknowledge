import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { BlobStore } from "@wknowledge/blob-store";
import type { LearningProgressReport } from "@wknowledge/contracts";

type StorageReservation = { commit(): Promise<void>; release(): Promise<void> };

const execFileAsync = promisify(execFile);

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function renderLearningReportArtifacts(input: {
  snapshotId: string;
  token: string;
  report: LearningProgressReport;
  blobStore: BlobStore;
  python: string;
  script: string;
  reserveStorage?: (byteSize: number) => Promise<StorageReservation>;
}) {
  const directory = await mkdtemp(path.join(tmpdir(), "wknowledge-learning-report-"));
  const source = path.join(directory, "report.json");
  const pngPath = path.join(directory, "report.png");
  const pdfPath = path.join(directory, "report.pdf");
  try {
    await writeFile(source, JSON.stringify(input.report), "utf8");
    await execFileAsync(
      input.python,
      [input.script, "--input", source, "--png", pngPath, "--pdf", pdfPath],
      {
        timeout: 60_000,
        maxBuffer: 64 * 1024
      }
    );
    const [png, pdf] = await Promise.all([readFile(pngPath), readFile(pdfPath)]);
    if (!png.byteLength || !pdf.byteLength) throw new Error("LEARNING_REPORT_RENDER_EMPTY");
    const storageReservation = await input.reserveStorage?.(png.byteLength + pdf.byteLength);
    let storageCommitted = false;
    try {
      await storageReservation?.commit();
      storageCommitted = true;
      const artifacts = await Promise.all(
        [
          { format: "png" as const, bytes: png },
          { format: "pdf" as const, bytes: pdf }
        ].map(async ({ format, bytes }) => {
          const sha256 = digest(bytes);
          const blobUri = await input.blobStore.putImmutable(
            `learning-reports/${input.snapshotId}/${input.token}.${format}`,
            bytes
          );
          return { format, blobUri, sha256, byteSize: bytes.byteLength };
        })
      );
      return artifacts;
    } catch (error) {
      if (!storageCommitted) await storageReservation?.release();
      throw error;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
