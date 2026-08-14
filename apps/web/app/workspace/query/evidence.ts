import type { EvidenceItem } from "@wknowledge/contracts";

export function partitionEvidence(
  items: EvidenceItem[],
  citedIds: ReadonlySet<string>
): { cited: EvidenceItem[]; related: EvidenceItem[] } {
  return {
    cited: items.filter(({ id }) => citedIds.has(id)),
    related: items.filter(({ id }) => !citedIds.has(id))
  };
}
