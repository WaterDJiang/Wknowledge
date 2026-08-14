import type { CompiledNode, SourceLocator } from "@wknowledge/contracts";

export interface MediaTranscriptItem {
  id: string;
  startMs: number;
  endMs: number;
  content: string;
  sourceKind: string;
}

export function activeMediaTranscriptId(
  items: readonly MediaTranscriptItem[],
  positionMs: number | null
): string | null {
  if (positionMs === null) return null;
  return items.find((item) => item.startMs <= positionMs && positionMs < item.endMs)?.id ?? null;
}

export function mediaTranscriptItems(
  nodes: readonly CompiledNode[],
  locator: Extract<SourceLocator, { type: "audio" | "video" }>
): MediaTranscriptItem[] {
  return nodes
    .filter(
      (
        node
      ): node is CompiledNode & {
        locator: Extract<SourceLocator, { type: "audio" | "video" }>;
      } =>
        node.kind === "transcript" &&
        node.locator.type === locator.type &&
        node.locator.resourceVersionId === locator.resourceVersionId
    )
    .filter(
      ({ locator: nodeLocator }) =>
        nodeLocator.startMs < locator.endMs && nodeLocator.endMs > locator.startMs
    )
    .sort((left, right) => left.locator.startMs - right.locator.startMs || left.order - right.order)
    .slice(0, 200)
    .map(({ id, locator: nodeLocator, content, metadata }) => ({
      id,
      startMs: nodeLocator.startMs,
      endMs: nodeLocator.endMs,
      content,
      sourceKind: typeof metadata.sourceKind === "string" ? metadata.sourceKind : "media_transcript"
    }));
}
