import type { ProcessingJob } from "@wknowledge/contracts";

interface StoredProcessingJob {
  id: string;
  spaceId: string;
  resourceVersionId: string | null;
  kind: string;
  status: ProcessingJob["status"];
  stage: string;
  progress: number;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: Date;
}

function sanitizeErrorMessage(code: string | null, message: string | null): string | null {
  if (!message) return null;
  if (code === "RESOURCE_PROCESS_FAILED") {
    if (message.includes("PARSER_MIME_UNSUPPORTED")) return "当前文件类型尚未配置解析器";
    if (message.includes("PARSER_EMPTY_RESULT")) return "文件中没有提取到可入库内容";
    return "文件解析失败，请确认文件内容与格式是否匹配";
  }
  if (code === "BLOB_STORAGE_FULL") return "存储空间不足，请联系管理员释放空间后重新处理";
  if (code === "ASR_PROVIDER_REQUIRED")
    return "语音转文字服务当前不可用，请在系统设置检查后重新处理";
  if (code === "QUEUE_PUBLISH_FAILED") return "处理队列暂时不可用，请稍后重试";
  return message.replace(/(['"])(?:[A-Za-z]:\\|\/)[^'"\n]+\1/g, "$1[受管路径]$1").slice(0, 500);
}

export function presentProcessingJob(job: StoredProcessingJob): ProcessingJob {
  return {
    id: job.id,
    spaceId: job.spaceId,
    resourceVersionId: job.resourceVersionId,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    progress: Math.max(0, Math.min(100, job.progress)),
    errorCode: job.errorCode,
    errorMessage: sanitizeErrorMessage(job.errorCode, job.errorMessage),
    updatedAt: job.updatedAt.toISOString()
  };
}
