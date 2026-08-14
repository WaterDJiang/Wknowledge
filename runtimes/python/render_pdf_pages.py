#!/usr/bin/env python3
"""Render bounded PDF page PNGs for Worker-owned compiled staging only."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


MAX_SOURCE_BYTES = 256 * 1024 * 1024
MAX_PAGES = 200
MAX_PAGE_PNG_BYTES = 8 * 1024 * 1024
MAX_PIXEL_DIMENSION = 2048
RENDER_DPI = 144


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    source = Path(args.input).resolve(strict=True)
    output_dir = Path(args.output_dir).resolve()
    if source.stat().st_size <= 0 or source.stat().st_size > MAX_SOURCE_BYTES:
        raise SystemExit("PDF_PAGE_RENDER_SOURCE_LIMIT")
    output_dir.mkdir(parents=True, exist_ok=False)
    import fitz

    pages: list[dict] = []
    with fitz.open(str(source)) as document:
        if not 0 < document.page_count <= MAX_PAGES:
            raise SystemExit("PDF_PAGE_RENDER_PAGE_LIMIT")
        for page_number, page in enumerate(document, start=1):
            rect = page.rect
            if rect.width <= 0 or rect.height <= 0:
                raise SystemExit("PDF_PAGE_RENDER_DIMENSIONS_INVALID")
            scale = RENDER_DPI / 72
            if max(rect.width * scale, rect.height * scale) > MAX_PIXEL_DIMENSION:
                scale = MAX_PIXEL_DIMENSION / max(rect.width, rect.height)
            pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            if pixmap.width <= 0 or pixmap.height <= 0:
                raise SystemExit("PDF_PAGE_RENDER_DIMENSIONS_INVALID")
            name = f"page-{page_number:03d}.png"
            destination = output_dir / name
            pixmap.save(str(destination))
            if destination.stat().st_size <= 0 or destination.stat().st_size > MAX_PAGE_PNG_BYTES:
                raise SystemExit("PDF_PAGE_RENDER_OUTPUT_LIMIT")
            pages.append(
                {
                    "page": page_number,
                    "path": f"pdf-pages/{name}",
                    "width": pixmap.width,
                    "height": pixmap.height,
                    "pdfPointWidth": float(rect.width),
                    "pdfPointHeight": float(rect.height),
                }
            )
    (output_dir / "manifest.json").write_text(
        json.dumps({"schemaVersion": 1, "pages": pages}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
