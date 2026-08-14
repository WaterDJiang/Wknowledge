const INLINE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/markdown",
  "audio/mpeg",
  "audio/wav",
  "audio/mp4",
  "audio/x-m4a",
  "video/mp4",
  "video/webm",
  "video/quicktime"
]);

export function mediaMatchesLocator(mimeType: string, locatorType: string): boolean {
  return (
    (mimeType.startsWith("audio/") && locatorType === "audio") ||
    (mimeType.startsWith("video/") && locatorType === "video")
  );
}

export function sourceContentDisposition(
  mimeType: string,
  version: number,
  locatorType: string
): string {
  const isMedia = mimeType.startsWith("audio/") || mimeType.startsWith("video/");
  const disposition =
    INLINE_MIME_TYPES.has(mimeType) && (!isMedia || mediaMatchesLocator(mimeType, locatorType))
      ? "inline"
      : "attachment";
  return `${disposition}; filename="source-v${version}"`;
}
