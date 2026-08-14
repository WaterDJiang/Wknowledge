import {
  sheetPreviewSchema,
  type CompiledDocument,
  type SheetPreview,
  type SourceLocator
} from "@wknowledge/contracts";

export function selectSheetPreview(
  document: CompiledDocument,
  locator: Extract<SourceLocator, { type: "sheet" }>
): SheetPreview | null {
  const node = document.nodes.find(
    (candidate) =>
      candidate.locator.type === "sheet" &&
      candidate.locator.sheet === locator.sheet &&
      candidate.locator.range === locator.range
  );
  if (!node || node.kind !== "table") return null;
  const metadata = node.metadata;
  return sheetPreviewSchema.parse({
    locator,
    content: node.content,
    metadata: {
      rowStart: metadata.rowStart,
      rowEnd: metadata.rowEnd,
      columnCount: metadata.columnCount,
      formulaSummaryTruncated: metadata.formulaSummaryTruncated ?? false,
      formulas: metadata.formulas ?? []
    }
  });
}
