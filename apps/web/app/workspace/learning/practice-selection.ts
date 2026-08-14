export function selectedPracticeUnitIds(
  completedUnitIds: readonly string[],
  excludedUnitIds: readonly string[]
): string[] {
  const excluded = new Set(excludedUnitIds);
  return completedUnitIds.filter((id) => !excluded.has(id));
}

export function togglePracticeUnitExclusion(
  excludedUnitIds: readonly string[],
  unitId: string
): string[] {
  return excludedUnitIds.includes(unitId)
    ? excludedUnitIds.filter((id) => id !== unitId)
    : [...excludedUnitIds, unitId];
}
