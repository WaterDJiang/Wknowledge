import {
  slidePreviewSchema,
  type CompiledDocument,
  type SlidePreview,
  type SourceLocator
} from "@wknowledge/contracts";

export function selectSlidePreview(
  document: CompiledDocument,
  locator: Extract<SourceLocator, { type: "slide" }>
): SlidePreview | null {
  const matching = document.nodes.filter(
    (candidate) =>
      candidate.kind === "slide" &&
      candidate.locator.type === "slide" &&
      candidate.locator.slide === locator.slide &&
      (!locator.shapeId || candidate.locator.shapeId === locator.shapeId)
  );
  if (!matching.length) return null;
  return slidePreviewSchema.parse({
    locator,
    items: matching.map((node) => ({
      shapeId: node.locator.type === "slide" ? (node.locator.shapeId ?? null) : null,
      role: node.metadata.contentRole === "notes" ? "notes" : "shape",
      content: node.content,
      textTruncated: node.metadata.textTruncated === true
    }))
  });
}
