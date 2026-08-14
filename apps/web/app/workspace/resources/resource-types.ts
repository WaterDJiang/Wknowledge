import type { ProcessingJob, WikiCompileProfile } from "@wknowledge/contracts";

export interface Resource {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
  compileProfile: WikiCompileProfile;
  currentVersion: number;
  versionCount: number;
  latestJob: ProcessingJob | null;
}

export interface ResourceVersionSummary {
  id: string;
  version: number;
  originalName: string;
  mimeType: string;
  byteSize: number;
  compileProfile: WikiCompileProfile;
  createdAt: string;
  latestJob: ProcessingJob | null;
}

export const PROFILE_LABELS: Record<WikiCompileProfile, string> = {
  knowledge: "知识提炼",
  case: "案例整理",
  reference: "资料归档"
};

export const STAGE_LABELS: Record<string, string> = {
  queued: "等待处理",
  retry_wait: "自动重试等待中",
  parsing: "正在解析文件",
  media_probe: "正在提取媒体结构与字幕",
  pdf_page_render: "正在生成 PDF 区域预览",
  video_keyframes: "正在抽取视频关键帧",
  video_keyframe_ocr: "正在识别关键帧文字",
  audio_transcribe: "正在转写音频",
  video_audio_transcribe: "正在转写视频音轨",
  wiki_compile: "正在编译知识库",
  cancel_requested: "正在取消处理",
  cancelled: "处理已取消",
  completed: "处理完成",
  failed: "处理失败"
};

export const STATUS_LABELS: Record<string, string> = {
  uploaded: "已上传",
  queued: "排队中",
  processing: "处理中",
  ready: "可检索",
  cancelled: "已取消",
  failed: "处理失败"
};
