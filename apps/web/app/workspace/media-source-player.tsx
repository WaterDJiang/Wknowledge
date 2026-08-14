"use client";

import { useEffect, useRef, useState } from "react";
import type { SourceLocator } from "@wknowledge/contracts";
import { mediaProgressPosition, shouldSyncMediaProgress } from "./media-learning-progress";
import { MediaTranscriptPanel } from "./media-transcript-panel";
import { VideoKeyframePanel } from "./video-keyframe-panel";

const AUDIO_MIME_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/mp4", "audio/x-m4a"]);
const VIDEO_MIME_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

interface MediaSourcePlayerProps {
  contentUrl: string;
  refValue: string;
  locator: Extract<SourceLocator, { type: "audio" | "video" }>;
  mimeType: string;
  title: string;
  onLearningProgress?: (positionMs: number) => Promise<void>;
}

function formatTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function isMediaPreviewSupported(locator: SourceLocator, mimeType: string): boolean {
  return (
    (locator.type === "audio" && AUDIO_MIME_TYPES.has(mimeType)) ||
    (locator.type === "video" && VIDEO_MIME_TYPES.has(mimeType))
  );
}

export function isMediaLocator(
  locator: SourceLocator
): locator is Extract<SourceLocator, { type: "audio" | "video" }> {
  return locator.type === "audio" || locator.type === "video";
}

export function MediaSourcePlayer({
  contentUrl,
  refValue,
  locator,
  mimeType,
  title,
  onLearningProgress
}: MediaSourcePlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastSyncedPositionRef = useRef<number | null>(null);
  const syncingProgressRef = useRef(false);
  const [status, setStatus] = useState("正在读取媒体元数据…");
  const [positionMs, setPositionMs] = useState<number | null>(locator.startMs);
  const startSeconds = locator.startMs / 1000;
  const endSeconds = locator.endMs / 1000;
  const isVideo = locator.type === "video";

  const seekToTranscript = (positionMs: number) => {
    const media = isVideo ? videoRef.current : audioRef.current;
    if (!media) return;
    const boundedPosition = Math.min(Math.max(positionMs, locator.startMs), locator.endMs);
    media.currentTime = boundedPosition / 1000;
    setPositionMs(boundedPosition);
    setStatus(`已定位到 ${formatTime(positionMs)}。`);
  };

  useEffect(() => {
    const media = isVideo ? videoRef.current : audioRef.current;
    if (!media) return;
    lastSyncedPositionRef.current = null;
    syncingProgressRef.current = false;
    const syncLearningPosition = (force = false) => {
      if (!onLearningProgress || syncingProgressRef.current) return;
      const positionMs = mediaProgressPosition(media.currentTime, locator.startMs, locator.endMs);
      if (
        positionMs === null ||
        !shouldSyncMediaProgress(lastSyncedPositionRef.current, positionMs, force)
      )
        return;
      syncingProgressRef.current = true;
      void onLearningProgress(positionMs)
        .then(() => {
          lastSyncedPositionRef.current = positionMs;
          setStatus(`学习位置已同步至 ${formatTime(positionMs)}。`);
        })
        .catch(() => setStatus("播放位置暂未同步；可继续学习。"))
        .finally(() => {
          syncingProgressRef.current = false;
        });
    };
    const moveToLocatorStart = () => {
      const target = Math.min(
        startSeconds,
        Number.isFinite(media.duration) ? media.duration : startSeconds
      );
      media.currentTime = target;
      setPositionMs(Math.round(target * 1000));
      setStatus(
        `已定位到 ${formatTime(locator.startMs)}；播放将在 ${formatTime(locator.endMs)} 暂停。`
      );
    };
    const pauseAtLocatorEnd = () => {
      setPositionMs(mediaProgressPosition(media.currentTime, locator.startMs, locator.endMs));
      if (media.currentTime >= endSeconds) {
        syncLearningPosition(true);
        media.pause();
        setStatus(`已到达定位结束时间 ${formatTime(locator.endMs)}。`);
        return;
      }
      syncLearningPosition();
    };
    const syncOnPause = () => syncLearningPosition(true);
    const failed = () => setStatus("当前浏览器无法播放此媒体；可在新窗口下载原资料。");

    media.addEventListener("loadedmetadata", moveToLocatorStart);
    media.addEventListener("timeupdate", pauseAtLocatorEnd);
    media.addEventListener("pause", syncOnPause);
    media.addEventListener("error", failed);
    return () => {
      media.removeEventListener("loadedmetadata", moveToLocatorStart);
      media.removeEventListener("timeupdate", pauseAtLocatorEnd);
      media.removeEventListener("pause", syncOnPause);
      media.removeEventListener("error", failed);
    };
  }, [endSeconds, isVideo, locator.endMs, locator.startMs, onLearningProgress, startSeconds]);

  const sharedProps = {
    className: "source-preview-media",
    controls: true,
    preload: "metadata" as const,
    "aria-label": `${title}原件播放`
  };

  return (
    <div className="source-preview-media-wrap">
      {isVideo ? (
        <video {...sharedProps} ref={videoRef}>
          <source src={contentUrl} type={mimeType} />
          当前浏览器不支持此视频播放。
        </video>
      ) : (
        <audio {...sharedProps} ref={audioRef}>
          <source src={contentUrl} type={mimeType} />
          当前浏览器不支持此音频播放。
        </audio>
      )}
      <p className="source-preview-media-status" role="status">
        {status}
      </p>
      <p className="source-preview-note">
        当前按这条来源记录的时间范围播放历史原件；
        {onLearningProgress
          ? "播放位置会记录到当前学习单元，完成仍需返回课程页手动确认。"
          : "字幕、音轨转写和画面证据以知识页面显示的独立来源为准。"}
      </p>
      <MediaTranscriptPanel refValue={refValue} positionMs={positionMs} onSeek={seekToTranscript} />
      {isVideo ? <VideoKeyframePanel refValue={refValue} onSeek={seekToTranscript} /> : null}
    </div>
  );
}
