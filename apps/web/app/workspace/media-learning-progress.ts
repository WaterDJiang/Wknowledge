export const MEDIA_PROGRESS_MINIMUM_DELTA_MS = 15_000;

export function mediaProgressPosition(
  currentTimeSeconds: number,
  startMs: number,
  endMs: number
): number | null {
  if (
    !Number.isFinite(currentTimeSeconds) ||
    !Number.isInteger(startMs) ||
    !Number.isInteger(endMs) ||
    startMs < 0 ||
    endMs < startMs
  )
    return null;
  const positionMs = Math.round(currentTimeSeconds * 1_000);
  return Math.max(startMs, Math.min(endMs, positionMs));
}

export function shouldSyncMediaProgress(
  lastSyncedPositionMs: number | null,
  positionMs: number,
  force = false
): boolean {
  return (
    lastSyncedPositionMs === null ||
    force ||
    Math.abs(positionMs - lastSyncedPositionMs) >= MEDIA_PROGRESS_MINIMUM_DELTA_MS
  );
}
