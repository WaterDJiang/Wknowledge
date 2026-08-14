"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiError, SourceLocator } from "@wknowledge/contracts";
import { isMediaLocator, isMediaPreviewSupported, MediaSourcePlayer } from "./media-source-player";
import { SheetSourcePreview } from "./sheet-source-preview";
import { SlideSourcePreview } from "./slide-source-preview";
import { ImageSourcePreview } from "./image-source-preview";
import { PdfRegionPreview } from "./pdf-region-preview";

interface SourceResolution {
  locator: SourceLocator;
  resource: { id: string; name: string };
  version: { id: string; version: number; mimeType: string };
}

const INLINE_NON_MEDIA_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/markdown"
]);

function locatorLabel(locator: SourceLocator): string {
  switch (locator.type) {
    case "pdf":
      return `第 ${locator.page} 页${locator.bbox ? " · 已记录区域" : ""}`;
    case "audio":
    case "video":
      return `${Math.floor(locator.startMs / 1000)}–${Math.ceil(locator.endMs / 1000)} 秒`;
    case "sheet":
      return `${locator.sheet} · ${locator.range}`;
    case "slide":
      return `第 ${locator.slide} 张幻灯片${locator.shapeId ? ` · ${locator.shapeId}` : ""}`;
    case "document":
      return `文档节点 · ${locator.nodeId}`;
    case "image":
      return locator.bbox ? "已记录图片区域" : "整张图片";
  }
}

function contentHref(ref: string, locator: SourceLocator): string {
  const base = `/api/source-locators/content?ref=${encodeURIComponent(ref)}`;
  return locator.type === "pdf" ? `${base}#page=${locator.page}` : base;
}

export function SourcePreview({
  refValue,
  learningUnitId
}: {
  refValue: string;
  learningUnitId?: string;
}) {
  const [loaded, setLoaded] = useState<{
    refValue: string;
    resolution: SourceResolution | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!refValue) return;
    const controller = new AbortController();
    void fetch(`/api/source-locators/resolve?ref=${encodeURIComponent(refValue)}`, {
      signal: controller.signal
    })
      .then(async (response) => {
        if (response.ok) return (await response.json()) as SourceResolution;
        const payload = (await response.json().catch(() => null)) as ApiError | null;
        throw new Error(payload?.message ?? "来源资料暂时不可打开");
      })
      .then((resolution) => setLoaded({ refValue, resolution, error: null }))
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name !== "AbortError")
          setLoaded({ refValue, resolution: null, error: cause.message });
      });
    return () => controller.abort();
  }, [refValue]);

  const current = loaded?.refValue === refValue ? loaded : null;
  const resolution = current?.resolution ?? null;
  const visibleError = refValue ? (current?.error ?? null) : "缺少来源定位，无法打开原资料。";
  const contentUrl = useMemo(
    () => (resolution ? contentHref(refValue, resolution.locator) : ""),
    [refValue, resolution]
  );
  const mediaSupported = resolution
    ? isMediaPreviewSupported(resolution.locator, resolution.version.mimeType)
    : false;
  const imageRegionSupported =
    resolution?.locator.type === "image" && Boolean(resolution.locator.bbox);
  const previewSupported = resolution
    ? imageRegionSupported ||
      mediaSupported ||
      INLINE_NON_MEDIA_MIME_TYPES.has(resolution.version.mimeType)
    : false;
  const recordLearningProgress = useCallback(
    async (positionMs: number) => {
      if (!learningUnitId) return;
      const response = await fetch("/api/learning/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          unitId: learningUnitId,
          verb: "progressed",
          sourceRef: refValue,
          position: { positionMs }
        })
      });
      if (response.ok) return;
      const payload = (await response.json().catch(() => null)) as ApiError | null;
      throw new Error(payload?.message ?? "学习位置保存失败");
    },
    [learningUnitId, refValue]
  );

  return (
    <section className="source-preview-panel panel">
      {!resolution && !visibleError ? (
        <p className="source-preview-state">正在验证来源权限并读取原资料…</p>
      ) : null}
      {visibleError ? (
        <div className="source-preview-state source-preview-error" role="alert">
          <b>无法打开来源</b>
          <p>{visibleError}</p>
        </div>
      ) : null}
      {resolution ? (
        <>
          <header className="source-preview-head">
            <div>
              <p>原资料预览</p>
              <h2>{resolution.resource.name}</h2>
              <span>
                历史版本 V{resolution.version.version} · {locatorLabel(resolution.locator)}
              </span>
            </div>
            <a href={contentUrl} target="_blank" rel="noreferrer">
              {resolution.locator.type === "image" && imageRegionSupported
                ? "打开原图 ↗"
                : resolution.locator.type === "sheet"
                  ? "下载原资料 ↗"
                  : previewSupported
                    ? "在新窗口打开 ↗"
                    : "下载原资料 ↗"}
            </a>
          </header>
          {mediaSupported && isMediaLocator(resolution.locator) ? (
            <MediaSourcePlayer
              contentUrl={contentUrl}
              refValue={refValue}
              locator={resolution.locator}
              mimeType={resolution.version.mimeType}
              title={resolution.resource.name}
              {...(learningUnitId ? { onLearningProgress: recordLearningProgress } : {})}
            />
          ) : resolution.locator.type === "sheet" ? (
            <SheetSourcePreview refValue={refValue} />
          ) : resolution.locator.type === "slide" ? (
            <SlideSourcePreview refValue={refValue} />
          ) : imageRegionSupported ? (
            <ImageSourcePreview contentUrl={contentUrl} refValue={refValue} />
          ) : resolution.locator.type === "pdf" && resolution.locator.bbox ? (
            <PdfRegionPreview refValue={refValue} />
          ) : previewSupported ? (
            <iframe
              className={`source-preview-frame source-preview-${resolution.locator.type}`}
              title={`原资料预览：${resolution.resource.name}`}
              src={contentUrl}
            />
          ) : (
            <div className="source-preview-state">
              <b>此文件类型暂不支持在线预览</b>
              <p>已保留当前历史版本和定位信息。可下载原资料；该定位与原件格式不支持在线预览。</p>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
