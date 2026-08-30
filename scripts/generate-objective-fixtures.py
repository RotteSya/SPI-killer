#!/usr/bin/env python3
"""Deterministically generate the 240-image Objective Result V1 release fixture set."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "Tests" / "Fixtures" / "objective-v1"
IMAGES = OUT / "images"
LANGUAGES = ("zh", "ja", "en")
KINDS = ("single_choice", "multiple_choice", "ordering", "short_fill")


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    )
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            pass
    return ImageFont.load_default()


TEXT = {
    "zh": {"choose": "请选择正确答案", "multi": "请选择所有正确答案", "order": "按从小到大排序", "fill": "请填写结果"},
    "ja": {"choose": "正しい答えを選んでください", "multi": "正しい答えをすべて選んでください", "order": "小さい順に並べてください", "fill": "答えを記入してください"},
    "en": {"choose": "Choose the correct answer", "multi": "Choose all correct answers", "order": "Order from smallest to largest", "fill": "Fill in the answer"},
}


def content(language: str, kind: str, index: int, state: str) -> tuple[list[str], list[str]]:
    t = TEXT[language]
    n = index + 3
    if kind == "single_choice":
        lines = [t["choose"], f"{n} + {n + 2} = ?", f"A. {2*n}", f"B. {2*n+2}", f"C. {2*n+3}", f"D. {2*n-1}"]
        answers = ["B"]
    elif kind == "multiple_choice":
        lines = [t["multi"], "2, 4, 5, 9", "A. 2", "B. 4", "C. 5", "D. 9"]
        answers = ["A, C", "A,C"]
    elif kind == "ordering":
        values = [n + 2, n - 1, n + 4, n]
        lines = [t["order"], f"A. {values[0]}   B. {values[1]}   C. {values[2]}   D. {values[3]}"]
        answers = ["B-D-A-C", "B, D, A, C"]
    else:
        lines = [t["fill"], f"{n} × 3 + 1 = ____"]
        answers = [str(n * 3 + 1)]
    if state == "review":
        # Preserve a usable answer while making either the stem or two choices visibly ambiguous.
        lines[-1] = lines[-1] + "   ?"
    return lines, answers


def render(path: Path, lines: list[str], state: str, seed: int) -> None:
    image = Image.new("RGB", (1200, 760), (244, 246, 250))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((70, 55, 1130, 705), radius=30, fill="white", outline=(210, 216, 228), width=3)
    y = 115
    for i, line in enumerate(lines):
        draw.text((125, y), line, fill=(23, 29, 40), font=font(39 if i == 0 else 34))
        y += 90 if i < 2 else 72
    if state == "retake":
        if seed % 2 == 0:
            # Keep only the instruction header; the actual stem/options are outside the shot.
            image = image.crop((0, 0, 1200, 175)).resize((1200, 760))
        else:
            # Downsample then blur so OCR cannot reconstruct the stem at the original resolution.
            image = image.resize((75, 48)).resize((1200, 760)).filter(ImageFilter.GaussianBlur(radius=9))
    image.save(path, format="PNG", optimize=True)


def main() -> None:
    IMAGES.mkdir(parents=True, exist_ok=True)
    manifest = []
    for language in LANGUAGES:
        for kind in KINDS:
            for index in range(20):
                state = "ready" if index < 14 else "review" if index < 17 else "retake"
                lines, answers = content(language, kind, index, state)
                fixture_id = f"{language}-{kind}-{index+1:02d}"
                relative = f"images/{fixture_id}.png"
                path = OUT / relative
                render(path, lines, state, index)
                manifest.append({
                    "id": fixture_id,
                    "language": language,
                    "kind": kind,
                    "expected_state": state,
                    "accepted_answers": [] if state == "retake" else answers,
                    "image": relative,
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "requires_context": False,
                })
    (OUT / "manifest.json").write_text(
        json.dumps({"schema_version": 1, "prompt_version": "objective-v1-r1", "fixtures": manifest},
                   ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"generated {len(manifest)} fixtures in {OUT}")


if __name__ == "__main__":
    main()
