#!/usr/bin/env python3
"""Deterministically generate the 240-image Objective Result V1 release fixture set."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "Tests" / "Fixtures" / "objective-v1"
IMAGES = OUT / "images"
LANGUAGES = ("zh", "ja", "en")
KINDS = ("single_choice", "multiple_choice", "ordering", "short_fill")


def font(size: int, language: str) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    preferred = {
        "zh": (
            "/System/Library/Fonts/STHeiti Medium.ttc",
            "/System/Library/Fonts/Supplemental/Songti.ttc",
        ),
        "ja": ("/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",),
        "en": (
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ),
    }
    candidates = preferred[language] + (
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/Supplemental/Songti.ttc",
        "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    )
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            pass
    return ImageFont.load_default()


TEXT = {
    "zh": {"choose": "请选择正确答案", "multi": "请选择所有质数", "order": "按从小到大排序", "fill": "请填写结果"},
    "ja": {"choose": "正しい答えを選んでください", "multi": "素数をすべて選んでください", "order": "小さい順に並べてください", "fill": "答えを記入してください"},
    "en": {"choose": "Choose the correct answer", "multi": "Choose all prime numbers", "order": "Order from smallest to largest", "fill": "Fill in the answer"},
}


def is_prime(value: int) -> bool:
    if value < 2:
        return False
    return all(value % divisor for divisor in range(2, math.isqrt(value) + 1))


def rotate(values: list[int], amount: int) -> list[int]:
    offset = amount % len(values)
    return values[offset:] + values[:offset]


def next_composites(start: int, excluded: set[int], count: int) -> list[int]:
    values = []
    candidate = start
    while len(values) < count:
        if candidate not in excluded and not is_prime(candidate):
            values.append(candidate)
        candidate += 1
    return values


def joined_answer_variants(labels: list[str], values: list[int]) -> list[str]:
    label_csv = ", ".join(labels)
    value_csv = ", ".join(map(str, values))
    variants = [
        label_csv,
        label_csv.replace(", ", ","),
        " and ".join(labels),
        " 和 ".join(labels),
        "と".join(labels),
        value_csv,
        value_csv.replace(", ", ","),
        " and ".join(map(str, values)),
        " 和 ".join(map(str, values)),
        "と".join(map(str, values)),
        f"{label_csv} ({value_csv})",
        f"{label_csv}（{value_csv}）",
    ]
    sorted_values = sorted(values)
    if sorted_values != values:
        sorted_csv = ", ".join(map(str, sorted_values))
        variants.extend([
            sorted_csv,
            sorted_csv.replace(", ", ","),
            " and ".join(map(str, sorted_values)),
            " 和 ".join(map(str, sorted_values)),
            "と".join(map(str, sorted_values)),
        ])
    return variants


def content(language: str, kind: str, index: int, state: str) -> tuple[list[str], list[str]]:
    t = TEXT[language]
    n = index + 3
    if kind == "single_choice":
        correct = 2 * n + 2
        values = rotate([correct, 2 * n, 2 * n + 3, 2 * n - 1], index)
        correct_index = values.index(correct)
        correct_label = "ABCD"[correct_index]
        shown_labels = list("ABCD")
        if state == "review":
            shown_labels[correct_index] = "?"
        lines = [t["choose"], f"{n} + {n + 2} = ?",
                 *[f"{label}. {value}" for label, value in zip(shown_labels, values)]]
        answers = ([str(correct), f"?. {correct}"] if state == "review" else [
            correct_label, str(correct), f"{correct_label}. {correct}",
            f"{correct_label} ({correct})", f"{correct_label}（{correct}）",
        ])
    elif kind == "multiple_choice":
        prime_pairs = [
            (2, 5), (3, 7), (11, 13), (17, 19), (23, 29),
            (31, 37), (41, 43), (47, 53), (59, 61), (67, 71),
            (73, 79), (83, 89), (97, 101), (103, 107), (109, 113),
            (127, 131), (137, 139), (149, 151), (157, 163), (167, 173),
        ]
        first, second = prime_pairs[index]
        composites = next_composites(first + 1, {first, second}, 2)
        values = rotate([first, composites[0], second, composites[1]], index)
        prime_indexes = [i for i, value in enumerate(values) if is_prime(value)]
        labels = list("ABCD")
        if state == "review":
            labels[prime_indexes[-1]] = "?"
        lines = [t["multi"], ", ".join(map(str, values)),
                 *[f"{label}. {value}" for label, value in zip(labels, values)]]
        prime_values = [values[i] for i in prime_indexes]
        answers = joined_answer_variants(
            [labels[i] for i in prime_indexes], prime_values)
    elif kind == "ordering":
        values = rotate([n + 2, n - 1, n + 4, n], index)
        ordered_indexes = sorted(range(4), key=values.__getitem__)
        shown_labels = list("ABCD")
        if state == "review":
            shown_labels[ordered_indexes[0]] = "?"
        lines = [t["order"],
                 "   ".join(f"{label}. {value}" for label, value in zip(shown_labels, values))]
        ordered = [values[i] for i in ordered_indexes]
        value_answers = [", ".join(map(str, ordered)), " < ".join(map(str, ordered)),
                         " → ".join(map(str, ordered)), "-".join(map(str, ordered))]
        ordered_labels = [shown_labels[i] for i in ordered_indexes]
        answers = value_answers if state == "review" else [
            "-".join(ordered_labels), ", ".join(ordered_labels),
            " → ".join(ordered_labels), *value_answers,
        ]
    else:
        if state == "review":
            low, high = n * 3 - 1, n * 3 + 1
            lines = [t["fill"], f"{n} × 3 ± 1 = ____"]
            answers = [f"{low} or {high}", f"{low}/{high}", f"{low}, {high}",
                       f"{low} 或 {high}", f"{low}または{high}"]
        else:
            lines = [t["fill"], f"{n} × 3 + 1 = ____"]
            answers = [str(n * 3 + 1)]
    return lines, answers


def render(path: Path, lines: list[str], state: str, seed: int, language: str) -> None:
    image = Image.new("RGB", (1200, 760), (244, 246, 250))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((70, 55, 1130, 705), radius=30, fill="white", outline=(210, 216, 228), width=3)
    y = 115
    for i, line in enumerate(lines):
        draw.text((125, y), line, fill=(23, 29, 40),
                  font=font(39 if i == 0 else 34, language))
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
                render(path, lines, state, index, language)
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
