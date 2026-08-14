"use client";

import { useEffect, useState } from "react";
import type { ApiError } from "@wknowledge/contracts";
import type { VideoKeyframeItem } from "./video-keyframes";

function formatTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VideoKeyframePanel({
  refValue,
  onSeek
}: {
  refValue: string;
  onSeek: (positionMs: number) => void;
}) {
  const [state, setState] = useState<
    { refValue: string; items: VideoKeyframeItem[]; error: string | null } | undefined
  >();
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/source-locators/keyframes?ref=${encodeURIComponent(refValue)}`, {
      signal: controller.signal
    })
      .then(async (response) => {
        if (response.ok) return (await response.json()) as { items?: VideoKeyframeItem[] };
        const payload = (await response.json().catch(() => null)) as ApiError | null;
        throw new Error(payload?.message ?? "视频关键帧暂时不可读取");
      })
      .then(({ items }) => setState({ refValue, items: items ?? [], error: null }))
      .catch((error: unknown) => {
        if (error instanceof Error && error.name !== "AbortError")
          setState({ refValue, items: [], error: error.message });
      });
    return () => controller.abort();
  }, [refValue]);
  const current = state?.refValue === refValue ? state : undefined;
  return (
    <section className="video-keyframe-panel" aria-label="视频关键帧">
      <header>
        <b>视频关键帧</b>
        <small>同一历史原件的抽帧；文字识别和 AI 画面描述会明确区分</small>
      </header>
      {!current ? <p>正在读取关键帧…</p> : null}
      {current?.error ? <p>{current.error}</p> : null}
      {current && !current.error && !current.items.length ? (
        <p>当前定位范围没有已处理的关键帧。</p>
      ) : null}
      {current?.items.length ? (
        <ol>
          {current.items.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => onSeek(item.startMs)}>
                {/* eslint-disable-next-line @next/next/no-img-element -- same-origin API requires session authorization */}
                <img
                  src={`/api/source-locators/keyframes/${item.id}?ref=${encodeURIComponent(refValue)}`}
                  alt={`原始视频 ${formatTime(item.startMs)} 的关键帧`}
                />
                <span>{formatTime(item.startMs)}</span>
              </button>
              {item.ocrLines.length ? (
                <div className="video-keyframe-ocr-lines">
                  <small>关键帧文字 · 仅识别此时刻画面中的文字</small>
                  {item.ocrLines.map((line) => (
                    <p key={line.id}>{line.content}</p>
                  ))}
                </div>
              ) : null}
              {item.visualDescription ? (
                <div className="video-keyframe-vision-description">
                  <small>
                    AI 画面描述 · 基于此帧，可能有误
                    {item.visualDescription.confidence === null
                      ? ""
                      : ` · 置信度 ${Math.round(item.visualDescription.confidence * 100)}%`}
                  </small>
                  <p>{item.visualDescription.content}</p>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      <p className="source-preview-note">
        点击关键帧只定位播放，不记录学习进度；OCR 只表示画面文字，AI 画面描述只表示该单帧推断。
      </p>
    </section>
  );
}
