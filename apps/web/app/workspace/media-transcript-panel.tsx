"use client";

import { useEffect, useState } from "react";
import { activeMediaTranscriptId, type MediaTranscriptItem } from "./media-transcript";

function formatTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function MediaTranscriptPanel({
  refValue,
  positionMs,
  onSeek
}: {
  refValue: string;
  positionMs: number | null;
  onSeek: (positionMs: number) => void;
}) {
  const [state, setState] = useState<
    { refValue: string; items: MediaTranscriptItem[]; error: string | null } | undefined
  >();
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/source-locators/media-transcript?ref=${encodeURIComponent(refValue)}`, {
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("字幕与转写暂时不可读取");
        return (await response.json()) as { items?: MediaTranscriptItem[] };
      })
      .then(({ items }) => setState({ refValue, items: items ?? [], error: null }))
      .catch((error: unknown) => {
        if (error instanceof Error && error.name !== "AbortError")
          setState({ refValue, items: [], error: "字幕与转写暂时不可读取" });
      });
    return () => controller.abort();
  }, [refValue]);
  const current = state?.refValue === refValue ? state : undefined;
  const activeId = activeMediaTranscriptId(current?.items ?? [], positionMs);
  return (
    <section className="media-transcript-panel" aria-label="字幕与转写">
      <header>
        <b>字幕与转写</b>
        <small>仅显示当前历史版本已处理的媒体文字</small>
      </header>
      {!current ? <p>正在读取字幕与转写…</p> : null}
      {current?.error ? <p>{current.error}</p> : null}
      {current && !current.error && !current.items.length ? (
        <p>当前定位范围没有可显示的字幕或转写。原件仍可按时间范围播放。</p>
      ) : null}
      {current?.items.length ? (
        <ol>
          {current.items.map((item) => (
            <li key={item.id} className={item.id === activeId ? "active" : undefined}>
              <button onClick={() => onSeek(item.startMs)}>
                <time>
                  {formatTime(item.startMs)}–{formatTime(item.endMs)}
                </time>
                <span>{item.content}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
      <p className="source-preview-note">
        字幕或转写只说明音频内容，不代表画面理解；点击文字只定位播放，不记录学习进度。
      </p>
    </section>
  );
}
