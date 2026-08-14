import { describe, expect, it } from "vitest";
import type { EvidenceItem } from "@wknowledge/contracts";
import { partitionEvidence } from "../app/workspace/query/evidence";

const evidence = (id: string): EvidenceItem => ({
  id: id as EvidenceItem["id"],
  pageId: `topic-${id}`,
  pageTitle: id,
  pageType: "topic",
  text: "可回查的资料摘要。",
  sourceRefs: ["wk://source/00000000-0000-4000-8000-000000000000/eyJ0eXBlIjoiZG9jdW1lbnQifQ"],
  conflicted: false
});

describe("query evidence display", () => {
  it("keeps retrieved candidates visible when a generated answer cites only one item", () => {
    const result = partitionEvidence(
      [evidence("evidence-01"), evidence("evidence-02"), evidence("evidence-03")],
      new Set(["evidence-01"])
    );

    expect(result.cited.map(({ id }) => id)).toEqual(["evidence-01"]);
    expect(result.related.map(({ id }) => id)).toEqual(["evidence-02", "evidence-03"]);
  });
});
