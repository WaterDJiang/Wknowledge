"use client";

import { useEffect, useState } from "react";
import type { ApiError, ImagePreview } from "@wknowledge/contracts";

export function ImageSourcePreview({
  refValue,
  contentUrl
}: {
  refValue: string;
  contentUrl: string;
}) {
  const [loaded, setLoaded] = useState<{
    refValue: string;
    preview: ImagePreview | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/source-locators/image-preview?ref=${encodeURIComponent(refValue)}`, {
      signal: controller.signal
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          { preview?: ImagePreview } | ApiError | null;
        if (!response.ok)
          throw new Error((payload as ApiError | null)?.message ?? "图片派生内容暂时不可读取");
        if (!payload || !("preview" in payload) || !payload.preview)
          throw new Error("图片派生内容暂时不可读取");
        setLoaded({ refValue, preview: payload.preview, error: null });
      })
      .catch((value: unknown) => {
        if (value instanceof Error && value.name !== "AbortError")
          setLoaded({ refValue, preview: null, error: value.message });
      });
    return () => controller.abort();
  }, [refValue]);

  const current = loaded?.refValue === refValue ? loaded : null;
  if (current?.error)
    return (
      <div className="source-preview-state source-preview-error" role="alert">
        <b>无法读取该图片区域</b>
        <p>{current.error}</p>
      </div>
    );
  if (!current?.preview) return <p className="source-preview-state">正在读取受权图片区域…</p>;
  const { locator, content, metadata } = current.preview;
  const [left, top, right, bottom] = locator.bbox;
  const areaStyle = {
    left: `${(left / metadata.imageWidth) * 100}%`,
    top: `${(top / metadata.imageHeight) * 100}%`,
    width: `${((right - left) / metadata.imageWidth) * 100}%`,
    height: `${((bottom - top) / metadata.imageHeight) * 100}%`
  };
  return (
    <section className="image-region-preview" aria-label="图片 OCR 区域">
      <div className="image-region-canvas">
        <div className="image-region-asset">
          {/* 原件受同源授权 API 保护；Image 优化器不会可靠传递当前会话。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="受权图片原件" src={contentUrl} />
          <span aria-hidden="true" className="image-region-highlight" style={areaStyle} />
        </div>
      </div>
      <div className="image-region-copy">
        <p>OCR 文字区域</p>
        <blockquote>{content}</blockquote>
        <small>
          像素范围 {left}, {top}, {right}, {bottom}
          {metadata.textTruncated ? " · 文字已截断" : ""}
        </small>
        <p>仅显示本地 OCR 文字与区域，不代表图片的图表、对象或视觉语义。</p>
      </div>
    </section>
  );
}
