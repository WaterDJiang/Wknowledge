import { LocalBlobStore } from "@wknowledge/blob-store";
import { getLearningReportArtifact } from "@wknowledge/core";
import { apiError, blobRoot, currentUser } from "../../../../../../../../lib/api";

export const runtime = "nodejs";

const contentTypes = { png: "image/png", pdf: "application/pdf" } as const;

export async function GET(
  _request: Request,
  context: { params: Promise<{ snapshotId: string; format: string }> }
) {
  const user = await currentUser();
  if (!user) return apiError(401, "AUTH_REQUIRED", "请先登录");
  const { snapshotId, format } = await context.params;
  if (format !== "png" && format !== "pdf")
    return apiError(400, "LEARNING_REPORT_ARTIFACT_FORMAT_INVALID", "报告格式不正确");
  try {
    const artifact = await getLearningReportArtifact({ snapshotId, userId: user.id, format });
    const bytes = await new LocalBlobStore(blobRoot()).read(artifact.blobUri);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": contentTypes[format],
        "content-length": String(artifact.byteSize),
        "content-disposition": `attachment; filename="learning-report-${snapshotId}.${format}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff"
      }
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "LEARNING_REPORT_ARTIFACT_UNAVAILABLE";
    if (code === "LEARNING_REPORT_SNAPSHOT_NOT_FOUND")
      return apiError(404, code, "报告不存在或无权查看");
    if (code === "LEARNING_REPORT_ARTIFACT_NOT_READY")
      return apiError(409, code, "报告仍在生成中，请稍后刷新");
    if (code === "BLOB_URI_UNSUPPORTED" || code === "ENOENT")
      return apiError(
        503,
        "LEARNING_REPORT_ARTIFACT_UNAVAILABLE",
        "报告文件暂时不可读取，请重新生成"
      );
    return apiError(
      503,
      "LEARNING_REPORT_ARTIFACT_UNAVAILABLE",
      "报告文件暂时不可读取，请稍后重试"
    );
  }
}
