import { SourcePreview } from "../source-preview";

export default async function SourcePage({
  searchParams
}: {
  searchParams: Promise<{ ref?: string; learningUnit?: string }>;
}) {
  const { ref, learningUnit } = await searchParams;
  return (
    <SourcePreview
      refValue={ref ?? ""}
      {...(learningUnit ? { learningUnitId: learningUnit } : {})}
    />
  );
}
