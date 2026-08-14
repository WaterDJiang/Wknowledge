import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, gt } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { LocalBlobStore } from "@wknowledge/blob-store";
import {
  dispatchPendingProcessingOutbox,
  dispatchPendingSkillRunOutbox,
  dispatchPendingLearningReportOutbox,
  cleanupExpiredChunkedUploads,
  executeBuiltinSkillRun,
  executeDynamicSkillRun,
  finalizeChunkedUpload,
  hasAvailableAsrProvider,
  hasAvailableVisionProvider,
  markChunkedUploadFinalizationFailure,
  publishCompiledFromStaging,
  reserveDerivedStorageWrite,
  claimLearningReportSnapshot,
  completeLearningReportSnapshot,
  failLearningReportSnapshot,
  recoverExpiredLearningReportSnapshots,
  recoverExpiredProcessingJobs
} from "@wknowledge/core";
import {
  claimProcessingExecution,
  closeDatabase,
  getDatabase,
  recordWorkerHeartbeat,
  removeWorkerHeartbeat,
  refreshProcessingExecution,
  schema,
  updateProcessingExecutionStage,
  withWikiPublicationLease
} from "@wknowledge/database";
import {
  compileWiki,
  initializeSpace,
  recoverWikiPublicationArtifacts,
  recoverWikiPublicationArtifactsInDataRoot
} from "@wknowledge/wiki";
import { createWorkerResourceParser } from "./resource-parser.js";
import { transcribeAudioVersion } from "./audio-transcription.js";
import {
  transcribeVideoAudioTrack,
  videoProbeHasAudioStream
} from "./video-audio-transcription.js";
import { extractVideoKeyframes } from "./video-keyframes.js";
import { extractVideoKeyframeOcr } from "./video-keyframe-ocr.js";
import { describeVideoKeyframes } from "./video-keyframe-vision.js";
import { renderPdfPages } from "./pdf-page-renderer.js";
import { createManagedAsrGateway } from "./managed-asr-gateway.js";
import { createManagedVisionGateway } from "./managed-vision-gateway.js";
import {
  executeManagedPlanComposeRun,
  executeManagedPracticeGenerateRun
} from "./learning-generation.js";
import { renderLearningReportArtifacts } from "./learning-report-renderer.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const workspaceRoot = path.resolve(
  process.env.WKNOWLEDGE_WORKSPACE_ROOT ?? path.join(import.meta.dirname, "../../..")
);
const dataRoot = path.resolve(
  process.env.WKNOWLEDGE_DATA_ROOT ?? path.join(workspaceRoot, "data", "spaces")
);
const blobRoot = path.resolve(
  process.env.WKNOWLEDGE_BLOB_ROOT ?? path.join(workspaceRoot, "data", "blobs")
);
const python = process.env.WKNOWLEDGE_PYTHON ?? "python3";
const parserScript = path.join(workspaceRoot, "runtimes", "python", "parse_document.py");
const pdfPageRendererScript = path.join(workspaceRoot, "runtimes", "python", "render_pdf_pages.py");
const reportRendererScript = path.join(
  workspaceRoot,
  "runtimes",
  "python",
  "render_learning_report.py"
);
const builtinSkillsRoot = path.join(workspaceRoot, "skills", "builtin");
const installedSkillsRoot = path.join(workspaceRoot, "skills", "installed");
const skillSandboxRoot = path.join(workspaceRoot, "data", "skill-sandboxes");
const skillBubblewrap = process.env.WKNOWLEDGE_BWRAP ?? "/usr/bin/bwrap";
const skillPython = process.env.WKNOWLEDGE_SKILL_PYTHON ?? "/usr/bin/python3";
const ffprobe = process.env.WKNOWLEDGE_FFPROBE ?? "ffprobe";
const ffmpeg = process.env.WKNOWLEDGE_FFMPEG ?? "ffmpeg";
const tesseract = process.env.WKNOWLEDGE_TESSERACT ?? "tesseract";
const resourceProcessQueue = process.env.WKNOWLEDGE_RESOURCE_PROCESS_QUEUE ?? "resource.process";
const skillRunQueue = process.env.WKNOWLEDGE_SKILL_RUN_QUEUE ?? "skill.run";
const learningReportQueue =
  process.env.WKNOWLEDGE_LEARNING_REPORT_QUEUE ?? "learning.report.render";
const testDelayAfterClaimMs = Number.parseInt(
  process.env.WKNOWLEDGE_TEST_DELAY_AFTER_CLAIM_MS ?? "0",
  10
);
const outboxDrainEnabled = process.env.WKNOWLEDGE_DISABLE_OUTBOX_DRAIN !== "1";
const recoveryJobIds = process.env.WKNOWLEDGE_RECOVERY_JOB_ID?.split(",").filter(Boolean);
const blobStore = new LocalBlobStore(blobRoot);
const resourceParser = createWorkerResourceParser({
  blobStore,
  blobRoot,
  python,
  parserScript,
  ffprobe,
  ffmpeg,
  tesseract
});
const db = getDatabase();
const workerInstanceId = process.env.WKNOWLEDGE_WORKER_INSTANCE_ID ?? randomUUID();
const workerStartedAt = new Date();
const boss = new PgBoss(connectionString);
boss.on("error", (error) => console.error("pg-boss error", error));

interface ResourceJobData {
  jobId: string;
  resourceVersionId: string;
}

interface UploadFinalizeJobData {
  jobId: string;
  uploadId: string;
}

interface SkillRunJobData {
  skillRunId: string;
}

interface LearningReportJobData {
  snapshotId: string;
}

class ProcessingCancelledError extends Error {
  constructor() {
    super("JOB_CANCELLED");
  }
}

class ProcessingExecutionLeaseLostError extends Error {
  constructor() {
    super("PROCESSING_EXECUTION_LEASE_LOST");
  }
}

function processingFailureCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (
    (error instanceof Error && error.message === "BLOB_STORAGE_FULL") ||
    code === "ENOSPC" ||
    code === "EDQUOT"
  )
    return "BLOB_STORAGE_FULL";
  if (error instanceof Error && error.message === "ASR_PROVIDER_REQUIRED")
    return "ASR_PROVIDER_REQUIRED";
  return "RESOURCE_PROCESS_FAILED";
}

function processingFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message === "ASR_PROVIDER_REQUIRED")
    return "语音转文字服务当前不可用，请在系统设置检查启用状态、健康检查与空间数据策略后重新处理";
  return error instanceof Error ? error.message : String(error);
}

function uploadFinalizationFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "BLOB_STORAGE_FULL" || message === "ASR_PROVIDER_REQUIRED") return message;
  if (
    message === "UPLOAD_HASH_MISMATCH" ||
    message === "UPLOAD_PART_SIZE_INVALID" ||
    message === "UPLOAD_ARCHIVE_UNSAFE" ||
    message === "UPLOAD_EXPIRED"
  )
    return message;
  return "UPLOAD_FINALIZATION_FAILED";
}

function uploadFinalizationFailureMessage(code: string): string {
  const messages: Record<string, string> = {
    BLOB_STORAGE_FULL: "存储空间不足，无法完成文件校验入库",
    UPLOAD_HASH_MISMATCH: "文件完整性校验失败，请重新选择文件后提交",
    UPLOAD_PART_SIZE_INVALID: "上传分片不完整或大小异常，请重新选择文件后提交",
    UPLOAD_ARCHIVE_UNSAFE: "文件安全校验未通过，请重新导出文件后提交",
    UPLOAD_EXPIRED: "上传会话已过期，请重新选择文件后提交",
    ASR_PROVIDER_REQUIRED:
      "语音转文字服务当前不可用，请在系统设置检查启用状态、健康检查与空间数据策略后重新提交",
    UPLOAD_FINALIZATION_FAILED: "文件校验入库失败，请重新选择文件后提交"
  };
  return messages[code] ?? "文件校验入库失败，请重新选择文件后提交";
}

function uploadFinalizationFailureIsTerminal(code: string): boolean {
  return (
    code === "UPLOAD_HASH_MISMATCH" ||
    code === "UPLOAD_PART_SIZE_INVALID" ||
    code === "UPLOAD_ARCHIVE_UNSAFE" ||
    code === "UPLOAD_EXPIRED" ||
    code === "ASR_PROVIDER_REQUIRED"
  );
}

async function markUploadFinalizationFailure(
  data: UploadFinalizeJobData,
  retry: { retryCount: number; retryLimit: number },
  error: unknown
): Promise<void> {
  const errorCode = uploadFinalizationFailureCode(error);
  const errorMessage = uploadFinalizationFailureMessage(errorCode);
  await markChunkedUploadFinalizationFailure({
    uploadId: data.uploadId,
    jobId: data.jobId,
    errorCode,
    errorMessage,
    terminal: uploadFinalizationFailureIsTerminal(errorCode) || retry.retryCount >= retry.retryLimit
  });
}

async function cancellationRequested(jobId: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return true;
  const [job] = await db
    .select({ status: schema.processingJobs.status })
    .from(schema.processingJobs)
    .where(eq(schema.processingJobs.id, jobId))
    .limit(1);
  return job?.status === "cancel_requested" || job?.status === "cancelled";
}

async function throwIfCancelled(jobId: string, signal?: AbortSignal): Promise<void> {
  if (await cancellationRequested(jobId, signal)) throw new ProcessingCancelledError();
}

async function markProcessingCancelled(jobId: string, resourceId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.processingJobs)
      .set({
        status: "cancelled",
        stage: "cancelled",
        finishedAt: new Date(),
        executionToken: null,
        executionLeaseExpiresAt: null,
        updatedAt: new Date()
      })
      .where(eq(schema.processingJobs.id, jobId));
    await tx
      .update(schema.resources)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(schema.resources.id, resourceId));
  });
}

async function markProcessingCompleted(
  jobId: string,
  resourceId: string,
  token: string
): Promise<void> {
  await db.transaction(async (tx) => {
    const [completed] = await tx
      .update(schema.processingJobs)
      .set({
        status: "completed",
        stage: "completed",
        progress: 100,
        finishedAt: new Date(),
        executionToken: null,
        executionLeaseExpiresAt: null,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(schema.processingJobs.id, jobId),
          eq(schema.processingJobs.status, "processing"),
          eq(schema.processingJobs.executionToken, token),
          gt(schema.processingJobs.executionLeaseExpiresAt, new Date())
        )
      )
      .returning({ id: schema.processingJobs.id });
    if (!completed) throw new ProcessingExecutionLeaseLostError();
    await tx
      .update(schema.resources)
      .set({ status: "ready", updatedAt: new Date() })
      .where(eq(schema.resources.id, resourceId));
  });
}

async function markProcessingFailed(
  jobId: string,
  resourceId: string,
  token: string,
  attempt: { retryCount: number; retryLimit: number },
  message: string,
  errorCode = "RESOURCE_PROCESS_FAILED"
): Promise<void> {
  const canRetryAutomatically = attempt.retryCount < attempt.retryLimit;
  await db.transaction(async (tx) => {
    const [failed] = await tx
      .update(schema.processingJobs)
      .set({
        status: canRetryAutomatically ? "queued" : "failed",
        stage: canRetryAutomatically ? "retry_wait" : "failed",
        errorCode,
        errorMessage: message.slice(0, 2_000),
        finishedAt: canRetryAutomatically ? null : new Date(),
        executionToken: null,
        executionLeaseExpiresAt: null,
        updatedAt: new Date()
      })
      .where(
        and(
          eq(schema.processingJobs.id, jobId),
          eq(schema.processingJobs.status, "processing"),
          eq(schema.processingJobs.executionToken, token),
          gt(schema.processingJobs.executionLeaseExpiresAt, new Date())
        )
      )
      .returning({ id: schema.processingJobs.id });
    if (!failed) throw new ProcessingExecutionLeaseLostError();
    await tx
      .update(schema.resources)
      .set({ status: canRetryAutomatically ? "queued" : "failed", updatedAt: new Date() })
      .where(eq(schema.resources.id, resourceId));
  });
}

async function processResource(
  data: ResourceJobData,
  attempt: { retryCount: number; retryLimit: number },
  signal?: AbortSignal
): Promise<void> {
  const [job] = await db
    .select()
    .from(schema.processingJobs)
    .where(eq(schema.processingJobs.id, data.jobId))
    .limit(1);
  const [version] = await db
    .select()
    .from(schema.resourceVersions)
    .where(eq(schema.resourceVersions.id, data.resourceVersionId))
    .limit(1);
  if (!job || !version) throw new Error("PROCESSING_TARGET_NOT_FOUND");
  const [resource] = await db
    .select()
    .from(schema.resources)
    .where(eq(schema.resources.id, version.resourceId))
    .limit(1);
  if (!resource) throw new Error("RESOURCE_NOT_FOUND");

  if (job.status === "cancelled" || job.status === "cancel_requested") {
    await markProcessingCancelled(job.id, resource.id);
    return;
  }

  const executionToken = randomUUID();
  if (!(await claimProcessingExecution(job.id, executionToken))) return;
  await db
    .update(schema.resources)
    .set({ status: "processing", updatedAt: new Date() })
    .where(eq(schema.resources.id, resource.id));
  if (Number.isSafeInteger(testDelayAfterClaimMs) && testDelayAfterClaimMs > 0)
    await delay(testDelayAfterClaimMs, undefined, { signal });

  let leaseLost = false;
  let heartbeatRunning = false;
  const heartbeat = async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      if (!(await refreshProcessingExecution(job.id, executionToken))) leaseLost = true;
    } catch {
      leaseLost = true;
    } finally {
      heartbeatRunning = false;
    }
  };
  const heartbeatTimer = setInterval(() => void heartbeat(), 30_000);
  const ensureExecutionLease = async () => {
    await throwIfCancelled(job.id, signal);
    if (leaseLost || !(await refreshProcessingExecution(job.id, executionToken)))
      throw new ProcessingExecutionLeaseLostError();
  };
  try {
    await ensureExecutionLease();
    if (version.mimeType === "video/mp4") {
      if (!(await updateProcessingExecutionStage(job.id, executionToken, "media_probe", 30)))
        throw new ProcessingExecutionLeaseLostError();
    }
    let parsed = await resourceParser.parseVersion(version, signal);
    let compiledAssets: Array<{ path: string; bytes: Uint8Array }> = [];
    const [space] = await db
      .select({
        organizationId: schema.knowledgeSpaces.organizationId,
        dataPolicy: schema.knowledgeSpaces.dataPolicy
      })
      .from(schema.knowledgeSpaces)
      .where(eq(schema.knowledgeSpaces.id, resource.spaceId))
      .limit(1);
    if (!space) throw new Error("SPACE_NOT_FOUND");
    if (version.mimeType === "application/pdf") {
      if (!(await updateProcessingExecutionStage(job.id, executionToken, "pdf_page_render", 35)))
        throw new ProcessingExecutionLeaseLostError();
      try {
        const pdfPages = await renderPdfPages({
          version,
          blobRoot,
          python,
          script: pdfPageRendererScript,
          ...(signal ? { signal } : {})
        });
        compiledAssets = [
          ...pdfPages.assets,
          {
            path: "pdf-pages/manifest.json",
            bytes: Buffer.from(`${JSON.stringify(pdfPages.manifest)}\n`, "utf8")
          }
        ];
        await db.insert(schema.auditEvents).values({
          organizationId: space.organizationId,
          action: "resource.pdf_pages.completed",
          targetType: "resource_version",
          targetId: version.id,
          metadata: { pageCount: pdfPages.manifest.pages.length }
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        await db.insert(schema.auditEvents).values({
          organizationId: space.organizationId,
          action: "resource.pdf_pages.skipped",
          targetType: "resource_version",
          targetId: version.id,
          metadata: { reason: "PDF_PAGE_RENDER_UNAVAILABLE" }
        });
      }
    }
    if (version.mimeType === "video/mp4") {
      if (!(await updateProcessingExecutionStage(job.id, executionToken, "video_keyframes", 35)))
        throw new ProcessingExecutionLeaseLostError();
      const keyframes = await extractVideoKeyframes({
        version,
        mediaProbe: parsed,
        blobRoot,
        ffmpeg,
        ...(signal ? { signal } : {})
      });
      parsed = keyframes.output;
      compiledAssets = keyframes.status === "completed" ? keyframes.assets : [];
      await db.insert(schema.auditEvents).values({
        organizationId: space.organizationId,
        action:
          keyframes.status === "completed"
            ? "resource.video_keyframes.completed"
            : "resource.video_keyframes.skipped",
        targetType: "resource_version",
        targetId: version.id,
        metadata:
          keyframes.status === "completed"
            ? { frameCount: keyframes.assets.length }
            : { reason: keyframes.reason }
      });
      if (keyframes.status === "completed") {
        if (
          !(await updateProcessingExecutionStage(job.id, executionToken, "video_keyframe_ocr", 37))
        )
          throw new ProcessingExecutionLeaseLostError();
        const keyframeOcr = await extractVideoKeyframeOcr({
          keyframes: parsed,
          assets: compiledAssets,
          python,
          parserScript,
          tesseract,
          ...(signal ? { signal } : {})
        });
        parsed = keyframeOcr.output;
        await db.insert(schema.auditEvents).values({
          organizationId: space.organizationId,
          action:
            keyframeOcr.status === "completed"
              ? "resource.video_keyframe_ocr.completed"
              : "resource.video_keyframe_ocr.skipped",
          targetType: "resource_version",
          targetId: version.id,
          metadata:
            keyframeOcr.status === "completed"
              ? { frameCount: keyframeOcr.frameCount, lineCount: keyframeOcr.lineCount }
              : { reason: keyframeOcr.reason }
        });
        if (await hasAvailableVisionProvider(space.organizationId, space.dataPolicy)) {
          if (
            !(await updateProcessingExecutionStage(
              job.id,
              executionToken,
              "video_visual_describe",
              39
            ))
          )
            throw new ProcessingExecutionLeaseLostError();
          try {
            const keyframeVision = await describeVideoKeyframes({
              keyframes: parsed,
              assets: compiledAssets,
              gateway: await createManagedVisionGateway(space.organizationId, space.dataPolicy),
              dataPolicy: space.dataPolicy,
              ...(signal ? { signal } : {})
            });
            parsed = keyframeVision.output;
            await db.insert(schema.auditEvents).values({
              organizationId: space.organizationId,
              action:
                keyframeVision.status === "completed"
                  ? "resource.video_vision.completed"
                  : "resource.video_vision.skipped",
              targetType: "resource_version",
              targetId: version.id,
              metadata:
                keyframeVision.status === "completed"
                  ? { descriptionCount: keyframeVision.descriptionCount }
                  : { reason: keyframeVision.reason }
            });
          } catch (error) {
            if (signal?.aborted) throw error;
            await db.insert(schema.auditEvents).values({
              organizationId: space.organizationId,
              action: "resource.video_vision.skipped",
              targetType: "resource_version",
              targetId: version.id,
              metadata: { reason: "VIDEO_VISION_UNAVAILABLE" }
            });
          }
        } else {
          await db.insert(schema.auditEvents).values({
            organizationId: space.organizationId,
            action: "resource.video_vision.skipped",
            targetType: "resource_version",
            targetId: version.id,
            metadata: { reason: "VISION_PROVIDER_REQUIRED" }
          });
        }
      }
    }
    if (version.mimeType.startsWith("audio/")) {
      if (!(await hasAvailableAsrProvider(space.organizationId, space.dataPolicy)))
        throw new Error("ASR_PROVIDER_REQUIRED");
      if (!(await updateProcessingExecutionStage(job.id, executionToken, "audio_transcribe", 35)))
        throw new ProcessingExecutionLeaseLostError();
      parsed = await transcribeAudioVersion({
        version,
        mediaProbe: parsed,
        blobStore,
        gateway: await createManagedAsrGateway(space.organizationId, space.dataPolicy),
        dataPolicy: space.dataPolicy
      });
      const transcript = parsed.document.nodes.find((node) => node.kind === "transcript");
      if (transcript) {
        await db.insert(schema.auditEvents).values({
          organizationId: space.organizationId,
          action: "resource.asr.completed",
          targetType: "resource_version",
          targetId: version.id,
          metadata: {
            providerId: transcript.metadata.providerId,
            model: transcript.metadata.model,
            durationMs: transcript.metadata.durationMs
          }
        });
      }
    }
    if (version.mimeType === "video/mp4") {
      if (!videoProbeHasAudioStream(parsed)) {
        await db.insert(schema.auditEvents).values({
          organizationId: space.organizationId,
          action: "resource.video_asr.skipped",
          targetType: "resource_version",
          targetId: version.id,
          metadata: { reason: "VIDEO_AUDIO_STREAM_MISSING" }
        });
      } else if (await hasAvailableAsrProvider(space.organizationId, space.dataPolicy)) {
        if (
          !(await updateProcessingExecutionStage(
            job.id,
            executionToken,
            "video_audio_transcribe",
            38
          ))
        )
          throw new ProcessingExecutionLeaseLostError();
        const videoAsr = await transcribeVideoAudioTrack({
          version,
          mediaProbe: parsed,
          blobRoot,
          gateway: await createManagedAsrGateway(space.organizationId, space.dataPolicy),
          dataPolicy: space.dataPolicy,
          ffmpeg,
          ...(signal ? { signal } : {})
        });
        parsed = videoAsr.output;
        await db.insert(schema.auditEvents).values({
          organizationId: space.organizationId,
          action:
            videoAsr.status === "completed"
              ? "resource.video_asr.completed"
              : "resource.video_asr.skipped",
          targetType: "resource_version",
          targetId: version.id,
          metadata:
            videoAsr.status === "completed"
              ? {
                  providerId: videoAsr.providerId,
                  model: videoAsr.model,
                  durationMs: videoAsr.durationMs
                }
              : { reason: videoAsr.reason }
        });
      } else {
        await db.insert(schema.auditEvents).values({
          organizationId: space.organizationId,
          action: "resource.video_asr.skipped",
          targetType: "resource_version",
          targetId: version.id,
          metadata: { reason: "ASR_PROVIDER_REQUIRED" }
        });
      }
    }
    if (!(await updateProcessingExecutionStage(job.id, executionToken, "compiled_write", 45)))
      throw new ProcessingExecutionLeaseLostError();
    const compiledPublished = await publishCompiledFromStaging({
      dataRoot,
      spaceId: resource.spaceId,
      output: parsed,
      executionToken,
      reserveStorage: (byteSize) =>
        reserveDerivedStorageWrite({
          organizationId: space.organizationId,
          assetKey: `compiled:${resource.spaceId}:${version.id}`,
          byteSize
        }),
      ...(compiledAssets.length ? { assets: compiledAssets } : {}),
      hasExecutionLease: async () => {
        if (leaseLost) return false;
        return refreshProcessingExecution(job.id, executionToken);
      }
    });
    if (!compiledPublished) throw new ProcessingExecutionLeaseLostError();
    if (!(await updateProcessingExecutionStage(job.id, executionToken, "wiki_compile", 60)))
      throw new ProcessingExecutionLeaseLostError();
    const spaceRoot = path.join(dataRoot, resource.spaceId);
    await ensureExecutionLease();
    await recoverWikiPublicationArtifacts(spaceRoot);
    await initializeSpace(dataRoot, resource.spaceId);
    await withWikiPublicationLease(resource.spaceId, "resource.compile", async () => {
      await ensureExecutionLease();
      await recoverWikiPublicationArtifacts(spaceRoot);
      await compileWiki(spaceRoot, {
        spaceId: resource.spaceId,
        resourceVersionId: version.id,
        resourceName: version.originalName,
        profile: version.compileProfile,
        nodes: parsed.document.nodes
      });
      await ensureExecutionLease();
    });
    await ensureExecutionLease();
    await markProcessingCompleted(job.id, resource.id, executionToken);
  } catch (error) {
    if (error instanceof ProcessingExecutionLeaseLostError) return;
    if (
      error instanceof ProcessingCancelledError ||
      (error as { name?: string }).name === "AbortError"
    ) {
      await markProcessingCancelled(job.id, resource.id);
      return;
    }
    await markProcessingFailed(
      job.id,
      resource.id,
      executionToken,
      attempt,
      processingFailureMessage(error),
      processingFailureCode(error)
    );
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

async function finalizeUpload(
  data: UploadFinalizeJobData,
  retry: { retryCount: number; retryLimit: number }
): Promise<void> {
  const [upload] = await db
    .select()
    .from(schema.resourceUploads)
    .where(eq(schema.resourceUploads.id, data.uploadId))
    .limit(1);
  if (!upload) throw new Error("UPLOAD_NOT_FOUND");
  if (upload.status === "completed") return;
  if (upload.status === "failed" || upload.status === "expired") {
    await markUploadFinalizationFailure(
      data,
      { retryCount: retry.retryLimit, retryLimit: retry.retryLimit },
      new Error(
        upload.status === "expired"
          ? "UPLOAD_EXPIRED"
          : (upload.errorCode ?? "UPLOAD_FINALIZATION_FAILED")
      )
    );
    return;
  }
  try {
    let allowAudioAsr = false;
    if (upload.mimeType.startsWith("audio/")) {
      const [space] = await db
        .select({
          organizationId: schema.knowledgeSpaces.organizationId,
          dataPolicy: schema.knowledgeSpaces.dataPolicy
        })
        .from(schema.knowledgeSpaces)
        .where(eq(schema.knowledgeSpaces.id, upload.spaceId))
        .limit(1);
      if (!space || !(await hasAvailableAsrProvider(space.organizationId, space.dataPolicy)))
        throw new Error("ASR_PROVIDER_REQUIRED");
      allowAudioAsr = true;
    }
    await finalizeChunkedUpload({
      uploadId: upload.id,
      userId: upload.userId,
      blobStore,
      queue: {
        async publish(name, payload) {
          if (name !== "resource.process" || !("resourceVersionId" in payload))
            throw new Error("UPLOAD_FINALIZE_QUEUE_KIND_INVALID");
          const queueJobId = await boss.send(resourceProcessQueue, payload, {
            retryLimit: 3,
            retryDelay: 10,
            expireInSeconds: 900
          });
          if (!queueJobId) throw new Error("QUEUE_OUTBOX_PUBLISH_FAILED");
          return queueJobId;
        }
      },
      allowAudioAsr
    });
    await db
      .update(schema.processingJobs)
      .set({ status: "completed", stage: "completed", progress: 100, finishedAt: new Date() })
      .where(eq(schema.processingJobs.id, data.jobId));
  } catch (error) {
    await markUploadFinalizationFailure(data, retry, error);
    throw error;
  }
}

async function renderLearningReport(data: LearningReportJobData): Promise<void> {
  const claimed = await claimLearningReportSnapshot(data.snapshotId);
  if (!claimed) return;
  try {
    const artifacts = await renderLearningReportArtifacts({
      snapshotId: claimed.snapshot.id,
      token: claimed.token,
      report: claimed.report,
      blobStore,
      python,
      script: reportRendererScript,
      reserveStorage: (byteSize) =>
        reserveDerivedStorageWrite({
          organizationId: claimed.organizationId,
          assetKey: `learning-report:${claimed.snapshot.id}`,
          byteSize
        })
    });
    await completeLearningReportSnapshot({
      snapshotId: claimed.snapshot.id,
      token: claimed.token,
      artifacts
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "LEARNING_REPORT_RENDER_FAILED";
    await failLearningReportSnapshot({
      snapshotId: claimed.snapshot.id,
      token: claimed.token,
      errorCode: code,
      errorMessage: "学习报告导出失败；请重新生成一份报告快照。"
    });
    throw error;
  }
}

await boss.start();
const writeWorkerHeartbeat = () =>
  recordWorkerHeartbeat({
    instanceId: workerInstanceId,
    startedAt: workerStartedAt,
    heartbeatAt: new Date()
  }).catch((error: unknown) => console.error("worker heartbeat error", error));
await writeWorkerHeartbeat();
const workerHeartbeatTimer = setInterval(() => void writeWorkerHeartbeat(), 30_000);
const resourceProcessDeadLetterQueue = `${resourceProcessQueue}.dead-letter`;
const uploadFinalizeQueue = "resource.upload.finalize";
const uploadFinalizeDeadLetterQueue = `${uploadFinalizeQueue}.dead-letter`;
const skillRunDeadLetterQueue = `${skillRunQueue}.dead-letter`;
const learningReportDeadLetterQueue = `${learningReportQueue}.dead-letter`;
await boss.createQueue(resourceProcessDeadLetterQueue);
await boss.createQueue(resourceProcessQueue, { deadLetter: resourceProcessDeadLetterQueue });
await boss.updateQueue(resourceProcessQueue, { deadLetter: resourceProcessDeadLetterQueue });
await boss.createQueue(uploadFinalizeDeadLetterQueue);
await boss.createQueue(uploadFinalizeQueue, { deadLetter: uploadFinalizeDeadLetterQueue });
await boss.updateQueue(uploadFinalizeQueue, { deadLetter: uploadFinalizeDeadLetterQueue });
await boss.createQueue(skillRunDeadLetterQueue);
await boss.createQueue(skillRunQueue, { deadLetter: skillRunDeadLetterQueue });
await boss.updateQueue(skillRunQueue, { deadLetter: skillRunDeadLetterQueue });
await boss.createQueue(learningReportDeadLetterQueue);
await boss.createQueue(learningReportQueue, { deadLetter: learningReportDeadLetterQueue });
await boss.updateQueue(learningReportQueue, { deadLetter: learningReportDeadLetterQueue });
const outboxQueue = {
  async publish(
    name: "resource.process" | "resource.upload.finalize",
    payload: ResourceJobData | UploadFinalizeJobData
  ) {
    const queueName = name === "resource.process" ? resourceProcessQueue : uploadFinalizeQueue;
    const queueJobId = await boss.send(queueName, payload, {
      retryLimit: 3,
      retryDelay: 10,
      expireInSeconds: 900
    });
    if (!queueJobId) throw new Error("QUEUE_OUTBOX_PUBLISH_FAILED");
    return queueJobId;
  }
};
const drainOutbox = async () => {
  const result = await dispatchPendingProcessingOutbox(outboxQueue);
  if (result.dispatched || result.discarded || result.failed)
    console.info("Processed resource job outbox", result);
};
const skillRunOutboxQueue = {
  async publish(name: "skill.run", payload: { skillRunId: string }) {
    const queueJobId = await boss.send(skillRunQueue, payload, {
      retryLimit: 3,
      retryDelay: 10,
      expireInSeconds: 900
    });
    if (!queueJobId) throw new Error("SKILL_RUN_OUTBOX_PUBLISH_FAILED");
    return queueJobId;
  }
};
const drainSkillRunOutbox = async () => {
  const result = await dispatchPendingSkillRunOutbox(skillRunOutboxQueue);
  if (result.dispatched || result.failed) console.info("Processed SkillRun outbox", result);
};
const learningReportOutboxQueue = {
  async publish(name: "learning.report.render", payload: LearningReportJobData) {
    const queueJobId = await boss.send(learningReportQueue, payload, {
      retryLimit: 3,
      retryDelay: 10,
      expireInSeconds: 900
    });
    if (!queueJobId) throw new Error("LEARNING_REPORT_OUTBOX_PUBLISH_FAILED");
    return queueJobId;
  }
};
const drainLearningReportOutbox = async () => {
  const result = await dispatchPendingLearningReportOutbox(learningReportOutboxQueue);
  if (result.dispatched || result.failed) console.info("Processed learning report outbox", result);
};
if (outboxDrainEnabled) await drainOutbox();
if (outboxDrainEnabled) await drainSkillRunOutbox();
if (outboxDrainEnabled) await drainLearningReportOutbox();
const outboxTimer = outboxDrainEnabled
  ? setInterval(() => {
      void drainOutbox().catch(() => console.error("Resource job outbox drain failed"));
      void drainSkillRunOutbox().catch(() => console.error("SkillRun outbox drain failed"));
      void drainLearningReportOutbox().catch(() =>
        console.error("Learning report outbox drain failed")
      );
    }, 5_000)
  : undefined;
const cleanupExpiredUploads = async () => {
  const result = await cleanupExpiredChunkedUploads(blobStore);
  if (result.sessionsExpired || result.partsDeleted || result.partDeleteFailures)
    console.info("Cleaned expired upload parts", result);
};
await cleanupExpiredUploads();
const expiredUploadCleanupTimer = setInterval(() => {
  void cleanupExpiredUploads().catch(() => console.error("Expired upload cleanup failed"));
}, 5 * 60_000);
const managedSpaceIds = new Set(
  (await db.select({ id: schema.knowledgeSpaces.id }).from(schema.knowledgeSpaces)).map(
    ({ id }) => id
  )
);
const wikiRecovery = await recoverWikiPublicationArtifactsInDataRoot(
  dataRoot,
  async (spaceId, spaceRoot) => {
    if (!managedSpaceIds.has(spaceId)) return null;
    try {
      return await withWikiPublicationLease(spaceId, "wiki.recover", () =>
        recoverWikiPublicationArtifacts(spaceRoot)
      );
    } catch (error) {
      if (error instanceof Error && error.message === "WIKI_PUBLICATION_LOCKED") return null;
      throw error;
    }
  }
);
if (wikiRecovery.length) console.info("Recovered interrupted wiki publications", wikiRecovery);
const recovery = await recoverExpiredProcessingJobs(
  {
    async publish(name, payload) {
      const queueJobId = await boss.send(resourceProcessQueue, payload, {
        retryLimit: 3,
        retryDelay: 10,
        expireInSeconds: 900
      });
      if (!queueJobId) throw new Error("QUEUE_RECOVERY_PUBLISH_FAILED");
      return queueJobId;
    }
  },
  { ...(recoveryJobIds ? { jobIds: recoveryJobIds } : {}) }
);
if (recovery.requeued || recovery.cancelled)
  console.info("Recovered interrupted processing jobs", recovery);
const recoveredLearningReports = await recoverExpiredLearningReportSnapshots();
if (recoveredLearningReports)
  console.info("Recovered interrupted learning report renders", { recoveredLearningReports });
await boss.work<ResourceJobData, void, { batchSize: 1; includeMetadata: true }>(
  resourceProcessQueue,
  { batchSize: 1, includeMetadata: true },
  async ([job]) => {
    if (!job) return;
    await processResource(
      job.data,
      {
        retryCount: job.retryCount,
        retryLimit: job.retryLimit
      },
      job.signal
    );
  }
);
await boss.work<UploadFinalizeJobData, void, { batchSize: 1; includeMetadata: true }>(
  uploadFinalizeQueue,
  { batchSize: 1, includeMetadata: true },
  async ([job]) => {
    if (!job) return;
    await finalizeUpload(job.data, { retryCount: job.retryCount, retryLimit: job.retryLimit });
  }
);
await boss.work<SkillRunJobData, void, { batchSize: 1; includeMetadata: true }>(
  skillRunQueue,
  { batchSize: 1, includeMetadata: true },
  async ([job]) => {
    if (!job) return;
    const result = await executeBuiltinSkillRun({
      skillRunId: job.data.skillRunId,
      dataRoot,
      builtinSkillsRoot
    });
    if (result.handled) {
      console.info("Processed builtin SkillRun", result);
      return;
    }
    if (result.status !== "not_builtin") return;
    const learningResult = await executeManagedPlanComposeRun({
      skillRunId: job.data.skillRunId,
      dataRoot,
      builtinSkillsRoot
    });
    if (learningResult.handled) {
      console.info("Processed managed learning SkillRun", learningResult);
      return;
    }
    if (learningResult.status !== "not_learning") return;
    const practiceResult = await executeManagedPracticeGenerateRun({
      skillRunId: job.data.skillRunId,
      builtinSkillsRoot
    });
    if (practiceResult.handled) {
      console.info("Processed managed practice SkillRun", practiceResult);
      return;
    }
    if (practiceResult.status !== "not_learning") return;
    const dynamicResult = await executeDynamicSkillRun({
      skillRunId: job.data.skillRunId,
      installedSkillsRoot,
      sandboxRoot: skillSandboxRoot,
      runtime: {
        bubblewrapPath: skillBubblewrap,
        nodePath: process.execPath,
        pythonPath: skillPython
      }
    });
    if (dynamicResult.handled) console.info("Processed dynamic SkillRun", dynamicResult);
  }
);
await boss.work<LearningReportJobData, void, { batchSize: 1; includeMetadata: true }>(
  learningReportQueue,
  { batchSize: 1, includeMetadata: true },
  async ([job]) => {
    if (!job) return;
    await renderLearningReport(job.data);
  }
);
console.info("Wknowledge worker started");

const shutdown = async () => {
  if (outboxTimer) clearInterval(outboxTimer);
  clearInterval(expiredUploadCleanupTimer);
  clearInterval(workerHeartbeatTimer);
  await removeWorkerHeartbeat(workerInstanceId).catch((error: unknown) =>
    console.error("worker heartbeat cleanup error", error)
  );
  await boss.stop();
  await closeDatabase();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
