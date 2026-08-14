"use client";

import { useEffect, useState } from "react";
import type { ApiError, PdfRegionPreview } from "@wknowledge/contracts";

export function PdfRegionPreview({ refValue }: { refValue: string }) {
  const [loaded, setLoaded] = useState<{
    refValue: string;
    preview: PdfRegionPreview | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/source-locators/pdf-region?ref=${encodeURIComponent(refValue)}`, {
      signal: controller.signal
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          { preview?: PdfRegionPreview } | ApiError | null;
        if (!response.ok)
          throw new Error((payload as ApiError | null)?.message ?? "PDF 区域预览暂时不可读取");
        if (!payload || !("preview" in payload) || !payload.preview)
          throw new Error("PDF 区域预览暂时不可读取");
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
        <b>无法读取 PDF 文字区域</b>
        <p>{current.error}</p>
      </div>
    );
  if (!current?.preview) return <p className="source-preview-state">正在读取受权 PDF 文字区域…</p>;
  const { locator, page, content, textTruncated } = current.preview;
  const [left, top, right, bottom] = locator.bbox;
  const areaStyle = {
    left: `${(left / page.pdfPointWidth) * 100}%`,
    top: `${(top / page.pdfPointHeight) * 100}%`,
    width: `${((right - left) / page.pdfPointWidth) * 100}%`,
    height: `${((bottom - top) / page.pdfPointHeight) * 100}%`
  };
  return (
    <section className="pdf-region-preview" aria-label="PDF 原生文字区域">
      <div className="pdf-region-canvas">
        <div className="pdf-region-asset" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
          {/* 页图经同源 API 的当前会话授权；Next 图片优化器不能可靠转发会话。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt={`PDF 第 ${locator.page} 页的受权页图`}
            src={`/api/source-locators/pdf-region/page?ref=${encodeURIComponent(refValue)}`}
          />
          <span aria-hidden="true" className="pdf-region-highlight" style={areaStyle} />
        </div>
      </div>
      <div className="pdf-region-copy">
        <p>已记录原生文字区域</p>
        <blockquote>{content}</blockquote>
        <small>
          PDF point 范围 {left.toFixed(1)}, {top.toFixed(1)}, {right.toFixed(1)},{" "}
          {bottom.toFixed(1)}
          {textTruncated ? " · 文字已截断" : ""}
        </small>
        <p>仅高亮 PDF 原生文字块，不代表扫描 OCR、表格结构或完整页面语义。</p>
      </div>
    </section>
  );
}
