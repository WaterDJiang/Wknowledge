import type { CompiledNode, SourceLocator } from "@wknowledge/contracts";

export interface VideoKeyframeItem {
  id: string;
  startMs: number;
  endMs: number;
  ocrLines: Array<{ id: string; content: string; bbox: [number, number, number, number] }>;
  visualDescription: { content: string; confidence: number | null } | null;
}

function isBbox(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  );
}

export function videoKeyframeItems(
  nodes: readonly CompiledNode[],
  locator: Extract<SourceLocator, { type: "video" }>
): VideoKeyframeItem[] {
  return nodes
    .filter(
      (
        node
      ): node is CompiledNode & {
        locator: Extract<SourceLocator, { type: "video" }>;
      } =>
        node.kind === "image" &&
        node.locator.type === "video" &&
        node.locator.resourceVersionId === locator.resourceVersionId &&
        node.metadata.source === "video_keyframe" &&
        typeof node.metadata.assetPath === "string"
    )
    .filter(
      ({ locator: nodeLocator }) =>
        nodeLocator.startMs < locator.endMs && nodeLocator.endMs > locator.startMs
    )
    .sort((left, right) => left.locator.startMs - right.locator.startMs || left.order - right.order)
    .slice(0, 8)
    .map((frame) => ({
      id: frame.id,
      startMs: frame.locator.startMs,
      endMs: frame.locator.endMs,
      ocrLines: nodes
        .filter(
          (node) =>
            node.kind === "image" &&
            node.locator.type === "video" &&
            node.locator.resourceVersionId === frame.locator.resourceVersionId &&
            node.metadata.source === "video_keyframe_ocr" &&
            node.metadata.frameId === frame.id &&
            isBbox(node.metadata.bbox)
        )
        .slice(0, 100)
        .flatMap((node) => {
          const bbox = node.metadata.bbox;
          return isBbox(bbox) ? [{ id: node.id, content: node.content, bbox }] : [];
        }),
      visualDescription:
        nodes
          .filter(
            (node) =>
              node.kind === "image" &&
              node.locator.type === "video" &&
              node.locator.resourceVersionId === frame.locator.resourceVersionId &&
              node.locator.startMs === frame.locator.startMs &&
              node.locator.endMs === frame.locator.endMs &&
              node.metadata.source === "video_keyframe_vision" &&
              node.metadata.sourceMarking === "ai_completed" &&
              node.metadata.contentRole === "visual_description" &&
              node.metadata.frameId === frame.id &&
              node.metadata.assetPath === frame.metadata.assetPath &&
              node.content.trim().length > 0
          )
          .sort((left, right) => left.order - right.order)
          .slice(0, 1)
          .flatMap((node) => {
            const confidence = node.metadata.confidence;
            return [
              {
                content: node.content,
                confidence:
                  typeof confidence === "number" &&
                  Number.isFinite(confidence) &&
                  confidence >= 0 &&
                  confidence <= 1
                    ? confidence
                    : null
              }
            ];
          })[0] ?? null
    }));
}
