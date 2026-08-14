export interface CorrectionProposal {
  pageId: string;
  proposal: string;
  sourceRefs: string[];
}

export function run(input: CorrectionProposal) {
  return { status: "pending_human_review" as const, proposal: input };
}
