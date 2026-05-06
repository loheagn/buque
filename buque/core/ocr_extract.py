from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import fitz

from buque.core.config import RuleConfig, ScoreWeights
from buque.core.models import CandidateHeading
from buque.core.scorer import (
    infer_numbered_level,
    normalize_title,
    pattern_score,
    position_score,
    semantic_score,
    total_score,
)
from buque.ocr import OCRBackend


@dataclass(slots=True)
class OCRExtractionResult:
    candidates: list[CandidateHeading]
    stats: dict[str, float]
    errors: list[dict[str, object]]


def extract_ocr_candidates(
    doc: fitz.Document,
    *,
    page_indexes: Iterable[int],
    backend: OCRBackend,
    lang: str,
    rules: RuleConfig,
    score_weights: ScoreWeights,
) -> OCRExtractionResult:
    candidates: list[CandidateHeading] = []
    errors: list[dict[str, object]] = []
    pages_attempted = 0
    pages_with_text = 0
    line_count = 0

    for page_index in page_indexes:
        if page_index < 0 or page_index >= doc.page_count:
            continue
        pages_attempted += 1
        page = doc[page_index]
        try:
            ocr_lines = backend.extract(page_image_bytes=_render_page_png(page), lang=lang)
        except Exception as exc:  # pragma: no cover - backend-specific failures are reported.
            errors.append(
                {
                    "page_index": page_index,
                    "reason": "ocr_backend_error",
                    "detail": str(exc),
                }
            )
            continue

        normalized_lines = [normalize_title(line) for line in ocr_lines]
        normalized_lines = [line for line in normalized_lines if line]
        if normalized_lines:
            pages_with_text += 1
        line_count += len(normalized_lines)
        candidates.extend(
            _lines_to_candidates(
                lines=normalized_lines,
                page_index=page_index,
                page_height=float(page.rect.height),
                rules=rules,
                score_weights=score_weights,
            )
        )

    return OCRExtractionResult(
        candidates=candidates,
        stats={
            "ocr_pages_attempted": float(pages_attempted),
            "ocr_pages_with_text": float(pages_with_text),
            "ocr_line_count": float(line_count),
            "ocr_candidate_count": float(len(candidates)),
        },
        errors=errors,
    )


def _render_page_png(page: fitz.Page) -> bytes:
    pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
    return pixmap.tobytes("png")


def _lines_to_candidates(
    *,
    lines: list[str],
    page_index: int,
    page_height: float,
    rules: RuleConfig,
    score_weights: ScoreWeights,
) -> list[CandidateHeading]:
    candidates: list[CandidateHeading] = []
    page_candidate_count = 0
    for line_index, text in enumerate(lines):
        if len(text) < rules.min_line_chars or len(text) > rules.max_line_chars:
            continue

        pattern = pattern_score(text)
        semantic = semantic_score(text)
        if pattern < rules.min_pattern_candidate and semantic < rules.min_semantic_candidate:
            continue
        if page_candidate_count >= rules.max_candidates_per_page:
            break

        top_ratio = _synthetic_top_ratio(line_index=line_index, total_lines=len(lines))
        position = position_score(top_ratio)
        style = _ocr_style_prior(pattern=pattern, semantic=semantic, top_ratio=top_ratio)
        score = total_score(
            weights=score_weights,
            style=style,
            position=position,
            pattern=pattern,
            semantic=semantic,
        )
        level_hint = infer_numbered_level(text) or 1
        bbox = _synthetic_bbox(line_index=line_index, page_height=page_height)
        candidates.append(
            CandidateHeading(
                page_index=page_index,
                text=text,
                bbox=bbox,
                source="ocr",
                style_score=style,
                position_score=position,
                pattern_score=pattern,
                semantic_score=semantic,
                total_score=score,
                level_hint=max(1, min(6, level_hint)),
            )
        )
        page_candidate_count += 1

    return candidates


def _synthetic_top_ratio(*, line_index: int, total_lines: int) -> float:
    if total_lines <= 1:
        return 0.12
    return max(0.05, min(0.95, (line_index + 1) / (total_lines + 1)))


def _synthetic_bbox(*, line_index: int, page_height: float) -> tuple[float, float, float, float]:
    y = max(0.0, min(page_height - 1.0, 72.0 + line_index * 18.0))
    return (72.0, y, 540.0, y + 12.0)


def _ocr_style_prior(*, pattern: float, semantic: float, top_ratio: float) -> float:
    if pattern >= 1.0:
        return 0.6
    if semantic >= 0.5 and top_ratio <= 0.4:
        return 0.5
    return 0.0
