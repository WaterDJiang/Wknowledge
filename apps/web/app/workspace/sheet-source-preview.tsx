"use client";

import { useEffect, useMemo, useState } from "react";
import type { ApiError, SheetPreview } from "@wknowledge/contracts";

export function SheetSourcePreview({ refValue }: { refValue: string }) {
  const [loaded, setLoaded] = useState<{
    refValue: string;
    preview: SheetPreview | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/source-locators/sheet-preview?ref=${encodeURIComponent(refValue)}`, {
      signal: controller.signal
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          { preview?: SheetPreview } | ApiError | null;
        if (!response.ok)
          throw new Error((payload as ApiError | null)?.message ?? "表格范围暂时不可读取");
        if (!payload || !("preview" in payload) || !payload.preview)
          throw new Error("表格范围暂时不可读取");
        setLoaded({ refValue, preview: payload.preview, error: null });
      })
      .catch((value: unknown) => {
        if (value instanceof Error && value.name !== "AbortError")
          setLoaded({ refValue, preview: null, error: value.message });
      });
    return () => controller.abort();
  }, [refValue]);

  const preview = loaded?.refValue === refValue ? loaded.preview : null;
  const error = loaded?.refValue === refValue ? loaded.error : null;
  const rows = useMemo(
    () => preview?.content.split("\n").map((row) => row.split("\t")) ?? [],
    [preview]
  );
  if (error)
    return (
      <div className="source-preview-state source-preview-error" role="alert">
        <b>无法读取该表格范围</b>
        <p>{error}</p>
      </div>
    );
  if (!preview) return <p className="source-preview-state">正在读取受权表格范围…</p>;
  return (
    <section
      className="sheet-preview"
      aria-label={`${preview.locator.sheet} ${preview.locator.range}`}
    >
      <header>
        <div>
          <p>表格范围</p>
          <h3>
            {preview.locator.sheet} · {preview.locator.range}
          </h3>
        </div>
        <small>
          第 {preview.metadata.rowStart}–{preview.metadata.rowEnd} 行 ·{" "}
          {preview.metadata.columnCount} 列
        </small>
      </header>
      <div className="sheet-preview-scroll">
        <table>
          <tbody>
            {rows.map((cells, index) => (
              <tr key={`${preview.locator.range}-${index}`}>
                <th scope="row">{preview.metadata.rowStart + index}</th>
                {cells.map((cell, cellIndex) => (
                  <td key={`${index}-${cellIndex}`}>{cell || "—"}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.metadata.formulas.length ? (
        <details className="sheet-preview-formulas">
          <summary>此范围内的公式 · {preview.metadata.formulas.length}</summary>
          <ul>
            {preview.metadata.formulas.map(({ cell, formula }) => (
              <li key={cell}>
                <code>{cell}</code> {formula}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {preview.metadata.formulaSummaryTruncated ? (
        <p className="sheet-preview-truncation">公式摘要已截断；请下载原资料查看完整公式。</p>
      ) : null}
    </section>
  );
}
