import {
  pdfPageManifestSchema,
  pdfRegionPreviewSchema,
  type CompiledDocument,
  type PdfPageManifest,
  type PdfRegionPreview,
  type SourceLocator
} from "@wknowledge/contracts";

export function parsePdfPageManifest(input: unknown): PdfPageManifest {
  return pdfPageManifestSchema.parse(input);
}

export function selectPdfRegionPreview(
  document: CompiledDocument,
  pageManifest: PdfPageManifest,
  locator: Extract<SourceLocator, { type: "pdf" }>
): PdfRegionPreview | null {
  if (!locator.bbox) return null;
  const node = document.nodes.find(
    (candidate) =>
      candidate.locator.type === "pdf" &&
      candidate.locator.page === locator.page &&
      candidate.locator.bbox?.every((value, index) => value === locator.bbox![index])
  );
  const page = pageManifest.pages.find((candidate) => candidate.page === locator.page);
  if (!node || !page) return null;
  const [left, top, right, bottom] = locator.bbox;
  if (left < 0 || top < 0 || right > page.pdfPointWidth || bottom > page.pdfPointHeight)
    return null;
  return pdfRegionPreviewSchema.parse({
    locator,
    page: {
      width: page.width,
      height: page.height,
      pdfPointWidth: page.pdfPointWidth,
      pdfPointHeight: page.pdfPointHeight
    },
    content: node.content,
    textTruncated: node.metadata.textTruncated === true
  });
}
