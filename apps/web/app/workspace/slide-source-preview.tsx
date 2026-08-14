"use client";

import { useEffect, useState } from "react";
import type { ApiError, SlidePreview } from "@wknowledge/contracts";

export function SlideSourcePreview({ refValue }: { refValue: string }) {
  const [loaded, setLoaded] = useState<{
    refValue: string;
    preview: SlidePreview | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/source-locators/slide-preview?ref=${encodeURIComponent(refValue)}`, {
      signal: controller.signal
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          { preview?: SlidePreview } | ApiError | null;
        if (!response.ok)
          throw new Error((payload as ApiError | null)?.message ?? "幻灯片派生内容暂时不可读取");
        if (!payload || !("preview" in payload) || !payload.preview)
          throw new Error("幻灯片派生内容暂时不可读取");
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
        <b>无法读取该幻灯片定位</b>
        <p>{current.error}</p>
      </div>
    );
  if (!current?.preview) return <p className="source-preview-state">正在读取受权幻灯片内容…</p>;
  const { locator, items } = current.preview;
  return (
    <section className="slide-preview" aria-label={`第 ${locator.slide} 张幻灯片`}>
      <header>
        <div>
          <p>幻灯片派生文字</p>
          <h3>
            第 {locator.slide} 张幻灯片{locator.shapeId ? ` · Shape ${locator.shapeId}` : ""}
          </h3>
        </div>
        <small>{locator.shapeId ? "指定文字区域" : `${items.length} 项派生内容`}</small>
      </header>
      <div className="slide-preview-items">
        {items.map((item, index) => (
          <article key={`${item.shapeId ?? "notes"}-${index}`}>
            <header>
              <span>{item.role === "notes" ? "备注" : `文字 Shape ${item.shapeId}`}</span>
              {item.textTruncated ? <small>内容已截断</small> : null}
            </header>
            <pre>{item.content}</pre>
          </article>
        ))}
      </div>
      <p className="slide-preview-note">这是可回查的文字提取，不代表原始版式、图片或图表内容。</p>
    </section>
  );
}
