import { apiError } from "./api";

export async function readChunkedUploadPartBytes(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number
) {
  if (!body) throw new Error("UPLOAD_PART_BODY_REQUIRED");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error("UPLOAD_PART_SIZE_INVALID");

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The stable client error is more useful than a stream cancellation failure.
        }
        throw new Error("UPLOAD_PART_SIZE_INVALID");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const clientErrors = new Set([
  "UPLOAD_SESSION_INVALID",
  "UPLOAD_NOT_OPEN",
  "UPLOAD_EXPIRED",
  "UPLOAD_PART_BODY_REQUIRED",
  "UPLOAD_PART_RANGE_INVALID",
  "UPLOAD_PART_SIZE_INVALID",
  "UPLOAD_PART_CONFLICT",
  "UPLOAD_INCOMPLETE",
  "UPLOAD_HASH_MISMATCH",
  "UPLOAD_NAME_INVALID",
  "UPLOAD_MIME_UNSUPPORTED",
  "UPLOAD_MIME_MISMATCH",
  "UPLOAD_ARCHIVE_UNSAFE",
  "BLOB_STORAGE_FULL",
  "STORAGE_QUOTA_EXCEEDED",
  "UPLOAD_SIZE_INVALID"
]);

export function chunkedUploadError(error: unknown) {
  const code = error instanceof Error ? error.message : "UPLOAD_FAILED";
  if (code === "BLOB_STORAGE_FULL")
    return apiError(507, code, "存储空间不足，暂时无法保存文件", "请联系管理员释放空间后重新提交");
  if (code === "STORAGE_QUOTA_EXCEEDED")
    return apiError(
      507,
      code,
      "组织存储额度不足，暂时无法创建上传",
      "请联系管理员清理资料或调整额度后重试"
    );
  if (code === "UPLOAD_NOT_FOUND") return apiError(404, code, "上传会话不存在或无权访问");
  if (code === "UPLOAD_EXPIRED")
    return apiError(410, code, "上传会话已过期", "请重新选择文件并开始上传");
  if (code === "UPLOAD_PART_CONFLICT")
    return apiError(409, code, "该分片已保存为不同内容", "请重新创建上传会话后重试");
  if (code === "ASR_PROVIDER_REQUIRED")
    return apiError(
      409,
      code,
      "当前知识空间没有可用的语音转文字服务",
      "请在系统设置启用并测试与空间数据策略相容的语音转文字 Provider"
    );
  if (code === "UPLOAD_NOT_OPEN") return apiError(409, code, "上传会话不再可写");
  if (clientErrors.has(code)) return apiError(400, code, "上传内容校验未通过", "检查文件后重试");
  return apiError(500, "UPLOAD_FAILED", "上传服务处理失败", "请稍后重试");
}
