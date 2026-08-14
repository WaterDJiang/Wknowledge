#!/usr/bin/env python3
"""Render a deterministic LearningProgressReport JSON into PNG and PDF artifacts.

This CLI receives only a frozen report snapshot. It never reads the business database,
source material, model output, or user answer text.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen.canvas import Canvas


WIDTH, HEIGHT = 1600, 1100
KLEIN = "#002FA7"
INK = "#15213B"
MUTED = "#556179"
PANEL = "#F5F7FC"


def load_report(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("report must be an object")
    units = value.get("units")
    practice = value.get("practice")
    mastery = value.get("mastery")
    if not isinstance(units, dict) or not isinstance(practice, dict) or not isinstance(mastery, dict):
        raise ValueError("report sections are required")
    for section, fields in [
        (units, ["total", "completed", "completionPercent"]),
        (practice, [
            "candidateSets",
            "questions",
            "attempts",
            "pendingReview",
            "objectiveGraded",
            "objectiveCorrect",
            "objectiveScore",
            "objectiveMaximumScore",
            "traceableAttempts",
        ]),
    ]:
        if not all(isinstance(section.get(field), (int, float)) for field in fields):
            raise ValueError("report metrics must be numeric")
    mastery_fields = ["totalKnowledgePoints", "gradedKnowledgePoints", "currentCorrect"]
    if not all(isinstance(mastery.get(field), int) for field in mastery_fields):
        raise ValueError("mastery metrics must be integer")
    if mastery.get("averagePercent") is not None and not isinstance(mastery.get("averagePercent"), (int, float)):
        raise ValueError("mastery average must be numeric or null")
    if not isinstance(mastery.get("items"), list):
        raise ValueError("mastery items must be a list")
    return value


def load_font(size: int, bold: bool = False):
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    ]
    if bold:
        candidates = [c for c in candidates if "Bold" in c] + candidates
    for candidate in candidates:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default()


def metrics(report: dict) -> list[tuple[str, str, str]]:
    units = report["units"]
    practice = report["practice"]
    mastery = report["mastery"]
    return [
        ("原文完成", f"{units['completed']} / {units['total']}", f"{units['completionPercent']}%"),
        ("候选练习", str(practice["questions"]), f"{practice['candidateSets']} 组"),
        ("已提交作答", str(practice["attempts"]), "不等于已评分"),
        (
            "客观回顾",
            f"{practice['objectiveScore']} / {practice['objectiveMaximumScore']}",
            f"{practice['objectiveCorrect']} / {practice['objectiveGraded']} 答对",
        ),
        ("待人工复核", str(practice["pendingReview"]), "尚未给分"),
        ("可回查作答", str(practice["traceableAttempts"]), "可打开原文依据"),
        (
            "评分证据表现",
            f"{mastery['gradedKnowledgePoints']} / {mastery['totalKnowledgePoints']}",
            "暂无评分证据" if mastery["averagePercent"] is None else f"当前均分 {mastery['averagePercent']}%",
        ),
    ]


def render_png(report: dict, output: Path) -> None:
    image = Image.new("RGB", (WIDTH, HEIGHT), "white")
    draw = ImageDraw.Draw(image)
    title_font = load_font(54, bold=True)
    heading_font = load_font(30, bold=True)
    value_font = load_font(42, bold=True)
    body_font = load_font(22)
    small_font = load_font(18)
    draw.rectangle((0, 0, WIDTH, 180), fill=KLEIN)
    draw.text((90, 55), "学习进展报告", fill="white", font=title_font)
    draw.text((93, 125), "固定快照 · 指标从学习事件与作答证据重建", fill="#DCE6FF", font=small_font)
    draw.text((90, 225), "课程完成度", fill=INK, font=heading_font)
    completion = report["units"]["completionPercent"]
    draw.text((1380, 220), f"{completion}%", fill=KLEIN, font=value_font)
    draw.rounded_rectangle((90, 285, 1510, 325), radius=20, fill="#DCE6FF")
    draw.rounded_rectangle((90, 285, 90 + int(1420 * completion / 100), 325), radius=20, fill=KLEIN)
    for index, (label, value, note) in enumerate(metrics(report)):
        row, column = divmod(index, 3)
        x = 90 + column * 480
        y = 390 + row * 190
        draw.rounded_rectangle((x, y, x + 440, y + 155), radius=24, fill=PANEL, outline="#D7DEEE", width=2)
        draw.text((x + 30, y + 27), label, fill=MUTED, font=body_font)
        draw.text((x + 30, y + 78), value, fill=KLEIN, font=value_font)
        draw.text((x + 30, y + 123), note, fill=MUTED, font=small_font)
    draw.line((90, 965, 1510, 965), fill="#D7DEEE", width=2)
    draw.text((90, 995), "评分证据表现只显示最近已评分作答，不代表 AI 推断或长期掌握。", fill=MUTED, font=small_font)
    image.save(output, format="PNG", optimize=True)


def render_pdf(report: dict, output: Path) -> None:
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    canvas = Canvas(str(output), pagesize=A4)
    page_width, page_height = A4
    canvas.setFillColor(HexColor(KLEIN))
    canvas.rect(0, page_height - 125, page_width, 125, fill=1, stroke=0)
    canvas.setFillColor(HexColor("#FFFFFF"))
    canvas.setFont("STSong-Light", 26)
    canvas.drawString(48, page_height - 68, "学习进展报告")
    canvas.setFont("STSong-Light", 10)
    canvas.drawString(48, page_height - 95, "固定快照 · 指标从学习事件与作答证据重建")
    canvas.setFillColor(HexColor(INK))
    canvas.setFont("STSong-Light", 16)
    canvas.drawString(48, page_height - 165, "课程完成度")
    completion = report["units"]["completionPercent"]
    canvas.setFillColor(HexColor(KLEIN))
    canvas.setFont("STSong-Light", 20)
    canvas.drawRightString(page_width - 48, page_height - 165, f"{completion}%")
    canvas.setFillColor(HexColor("#DCE6FF"))
    canvas.roundRect(48, page_height - 205, page_width - 96, 18, 9, fill=1, stroke=0)
    canvas.setFillColor(HexColor(KLEIN))
    canvas.roundRect(48, page_height - 205, (page_width - 96) * completion / 100, 18, 9, fill=1, stroke=0)
    for index, (label, value, note) in enumerate(metrics(report)):
        row, column = divmod(index, 3)
        x = 48 + column * 167
        y = page_height - 285 - row * 110
        canvas.setFillColor(HexColor(PANEL))
        canvas.roundRect(x, y, 150, 92, 10, fill=1, stroke=0)
        canvas.setFillColor(HexColor(MUTED))
        canvas.setFont("STSong-Light", 11)
        canvas.drawString(x + 12, y + 66, label)
        canvas.setFillColor(HexColor(KLEIN))
        canvas.setFont("STSong-Light", 17)
        canvas.drawString(x + 12, y + 40, value)
        canvas.setFillColor(HexColor(MUTED))
        canvas.setFont("STSong-Light", 8)
        canvas.drawString(x + 12, y + 16, note)
    canvas.setStrokeColor(HexColor("#D7DEEE"))
    canvas.line(48, 75, page_width - 48, 75)
    canvas.setFillColor(HexColor(MUTED))
    canvas.setFont("STSong-Light", 8)
    canvas.drawString(48, 54, "评分证据表现只显示最近已评分作答，不代表 AI 推断或长期掌握。")
    canvas.save()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--png", required=True)
    parser.add_argument("--pdf", required=True)
    args = parser.parse_args()
    report = load_report(Path(args.input))
    render_png(report, Path(args.png))
    render_pdf(report, Path(args.pdf))
    print(json.dumps({"schemaVersion": 1, "png": args.png, "pdf": args.pdf}, ensure_ascii=False))


if __name__ == "__main__":
    main()
