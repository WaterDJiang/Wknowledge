import {
  imagePreviewSchema,
  type CompiledDocument,
  type ImagePreview,
  type SourceLocator
} from "@wknowledge/contracts";

export function selectImagePreview(
  document: CompiledDocument,
  locator: Extract<SourceLocator, { type: "image" }>
): ImagePreview | null {
  if (!locator.bbox) return null;
  const node = document.nodes.find(
    (candidate) =>
      candidate.kind === "image" &&
      candidate.locator.type === "image" &&
      candidate.locator.bbox?.every((value, index) => value === locator.bbox![index])
  );
  if (!node || node.locator.type !== "image") return null;
  const { imageWidth, imageHeight, textTruncated } = node.metadata;
  if (
    typeof imageWidth !== "number" ||
    typeof imageHeight !== "number" ||
    !Number.isInteger(imageWidth) ||
    !Number.isInteger(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  )
    return null;
  return imagePreviewSchema.parse({
    locator,
    content: node.content,
    metadata: { imageWidth, imageHeight, textTruncated: textTruncated === true }
  });
}
