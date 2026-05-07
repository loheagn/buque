from __future__ import annotations

from concurrent.futures import FIRST_COMPLETED, Future, ProcessPoolExecutor, wait
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass
import os
import re
from statistics import median
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
from buque.ocr import OCRBackend, OCRLine, OCRTextLine
from buque.ocr.spec import OCRBackendSpec, backend_from_spec, backend_to_spec

_DEFAULT_RENDER_SCALE = 2.0
_MAX_IN_FLIGHT_PER_WORKER = 2
_WORKER_BACKEND: OCRBackend | None = None
_CHINESE_VOLUME_TITLE_RE = re.compile(r"^\s*第[零一二三四五六七八九十百千万〇\d]+卷")
_CHINESE_CHAPTER_TITLE_RE = re.compile(r"^\s*第[零一二三四五六七八九十百千万〇\d]+章")
_HEADING_PREFIX_RE = re.compile(
    r"^\s*(第[零一二三四五六七八九十百千万〇\d]+[卷章节]|附录|绪论[:：]?|尾\s*声)\s*$"
)


@dataclass(slots=True)
class OCRExtractionResult:
    candidates: list[CandidateHeading]
    stats: dict[str, object]
    errors: list[dict[str, object]]


@dataclass(slots=True)
class OCRPageRunResult:
    page_lines: dict[int, list["_OCRLine"]]
    stats: dict[str, object]
    errors: list[dict[str, object]]


@dataclass(slots=True)
class _OCRLine:
    text: str
    bbox: tuple[float, float, float, float]
    confidence: float | None = None

    @property
    def top_ratio(self) -> float:
        if self.bbox[3] <= self.bbox[1]:
            return 1.0
        return max(0.0, self.bbox[1])

    @property
    def height(self) -> float:
        return max(0.0, self.bbox[3] - self.bbox[1])


def extract_ocr_candidates(
    doc: fitz.Document,
    *,
    page_indexes: Iterable[int],
    backend: OCRBackend,
    lang: str,
    rules: RuleConfig,
    score_weights: ScoreWeights,
    ocr_parallelism: int = 1,
) -> OCRExtractionResult:
    candidates: list[CandidateHeading] = []
    page_run = run_ocr_pages(
        doc,
        page_indexes=page_indexes,
        backend=backend,
        lang=lang,
        render_scale=_render_scale(),
        ocr_parallelism=ocr_parallelism,
    )
    page_line_map = page_run.page_lines

    body_line_height = _estimate_body_line_height(
        line
        for page_lines in page_line_map.values()
        for line in page_lines
    )
    for page_index, normalized_lines in page_line_map.items():
        page = doc[page_index]
        candidates.extend(
            _lines_to_candidates(
                lines=normalized_lines,
                page_index=page_index,
                page_height=float(page.rect.height),
                body_line_height=body_line_height,
                rules=rules,
                score_weights=score_weights,
            )
        )
    _apply_ocr_contextual_levels(candidates)

    return OCRExtractionResult(
        candidates=candidates,
        stats={
            **page_run.stats,
            "ocr_candidate_count": float(len(candidates)),
        },
        errors=page_run.errors,
    )


def run_ocr_pages(
    doc: fitz.Document,
    *,
    page_indexes: Iterable[int],
    backend: OCRBackend,
    lang: str,
    render_scale: float,
    ocr_parallelism: int = 1,
) -> OCRPageRunResult:
    normalized_parallelism = _normalize_parallelism(ocr_parallelism)
    indexes = _valid_unique_page_indexes(page_indexes, page_count=doc.page_count)
    backend_spec = backend_to_spec(backend)
    if normalized_parallelism <= 1 or backend_spec is None or len(indexes) <= 1:
        fallback_to_serial = normalized_parallelism > 1 and backend_spec is None
        return _run_ocr_pages_serial(
            doc,
            page_indexes=indexes,
            backend=backend,
            lang=lang,
            render_scale=render_scale,
            requested_parallelism=normalized_parallelism,
            fallback_to_serial=fallback_to_serial,
        )

    effective_parallelism = min(normalized_parallelism, len(indexes))
    try:
        return _run_ocr_pages_process(
            doc,
            page_indexes=indexes,
            backend_spec=backend_spec,
            lang=lang,
            render_scale=render_scale,
            requested_parallelism=normalized_parallelism,
            effective_parallelism=effective_parallelism,
        )
    except Exception:
        return _run_ocr_pages_serial(
            doc,
            page_indexes=indexes,
            backend=backend,
            lang=lang,
            render_scale=render_scale,
            requested_parallelism=normalized_parallelism,
            fallback_to_serial=True,
        )


def _run_ocr_pages_serial(
    doc: fitz.Document,
    *,
    page_indexes: list[int],
    backend: OCRBackend,
    lang: str,
    render_scale: float,
    requested_parallelism: int,
    fallback_to_serial: bool = False,
) -> OCRPageRunResult:
    page_line_map: dict[int, list[_OCRLine]] = {}
    errors: list[dict[str, object]] = []
    line_count = 0
    pages_with_text = 0
    for page_index in page_indexes:
        page = doc[page_index]
        if _env_bool("BUQUE_OCR_PROGRESS"):
            print(f"OCR page {page_index + 1}/{doc.page_count}", flush=True)
        try:
            ocr_lines = backend.extract(
                page_image_bytes=_render_page_png(page, render_scale=render_scale),
                lang=lang,
            )
        except Exception as exc:  # pragma: no cover - backend-specific failures are reported.
            errors.append(_ocr_page_error(page_index, exc))
            page_line_map[page_index] = []
            continue

        normalized_lines = _coerce_ocr_lines(
            ocr_lines,
            page_height=float(page.rect.height),
            render_scale=render_scale,
        )
        if normalized_lines:
            pages_with_text += 1
        line_count += len(normalized_lines)
        page_line_map[page_index] = normalized_lines

    return OCRPageRunResult(
        page_lines={page_index: page_line_map[page_index] for page_index in sorted(page_line_map)},
        stats=_ocr_page_run_stats(
            pages_attempted=len(page_indexes),
            pages_with_text=pages_with_text,
            line_count=line_count,
            requested_parallelism=requested_parallelism,
            effective_parallelism=1,
            mode="serial",
            fallback_to_serial=fallback_to_serial,
        ),
        errors=errors,
    )


def _run_ocr_pages_process(
    doc: fitz.Document,
    *,
    page_indexes: list[int],
    backend_spec: OCRBackendSpec,
    lang: str,
    render_scale: float,
    requested_parallelism: int,
    effective_parallelism: int,
) -> OCRPageRunResult:
    page_line_map: dict[int, list[_OCRLine]] = {}
    errors: list[dict[str, object]] = []
    line_count = 0
    pages_with_text = 0
    page_heights: dict[int, float] = {}
    max_in_flight = max(1, effective_parallelism * _MAX_IN_FLIGHT_PER_WORKER)
    pending: dict[Future[tuple[int, list[OCRLine], dict[str, object] | None]], int] = {}
    page_iter = iter(page_indexes)

    with ProcessPoolExecutor(
        max_workers=effective_parallelism,
        initializer=_init_ocr_worker,
        initargs=(backend_spec,),
    ) as executor:

        def submit_next() -> bool:
            try:
                page_index = next(page_iter)
            except StopIteration:
                return False
            page = doc[page_index]
            page_heights[page_index] = float(page.rect.height)
            if _env_bool("BUQUE_OCR_PROGRESS"):
                print(f"OCR page {page_index + 1}/{doc.page_count}", flush=True)
            future = executor.submit(
                _extract_ocr_page_in_worker,
                page_index,
                _render_page_png(page, render_scale=render_scale),
                lang,
            )
            pending[future] = page_index
            return True

        while len(pending) < max_in_flight and submit_next():
            pass

        while pending:
            done, _pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                page_index = pending.pop(future)
                try:
                    result_page_index, ocr_lines, error = future.result()
                except BrokenProcessPool:
                    raise
                except Exception as exc:  # pragma: no cover - process failures are backend/runtime specific.
                    errors.append(_ocr_page_error(page_index, exc))
                    page_line_map[page_index] = []
                    continue

                if error is not None:
                    errors.append(error)
                    page_line_map[result_page_index] = []
                    continue

                normalized_lines = _coerce_ocr_lines(
                    ocr_lines,
                    page_height=page_heights[result_page_index],
                    render_scale=render_scale,
                )
                if normalized_lines:
                    pages_with_text += 1
                line_count += len(normalized_lines)
                page_line_map[result_page_index] = normalized_lines

            while len(pending) < max_in_flight and submit_next():
                pass

    return OCRPageRunResult(
        page_lines={page_index: page_line_map[page_index] for page_index in sorted(page_line_map)},
        stats=_ocr_page_run_stats(
            pages_attempted=len(page_indexes),
            pages_with_text=pages_with_text,
            line_count=line_count,
            requested_parallelism=requested_parallelism,
            effective_parallelism=effective_parallelism,
            mode="process",
            fallback_to_serial=False,
        ),
        errors=errors,
    )


def _init_ocr_worker(backend_spec: OCRBackendSpec) -> None:
    global _WORKER_BACKEND
    _WORKER_BACKEND = backend_from_spec(backend_spec)


def _extract_ocr_page_in_worker(
    page_index: int,
    page_image_bytes: bytes,
    lang: str,
) -> tuple[int, list[OCRLine], dict[str, object] | None]:
    if _WORKER_BACKEND is None:
        return page_index, [], {"page_index": page_index, "reason": "ocr_backend_error", "detail": "OCR worker is not initialized."}
    try:
        return page_index, _WORKER_BACKEND.extract(page_image_bytes=page_image_bytes, lang=lang), None
    except Exception as exc:  # pragma: no cover - backend-specific failures are reported.
        return page_index, [], _ocr_page_error(page_index, exc)


def _valid_unique_page_indexes(page_indexes: Iterable[int], *, page_count: int) -> list[int]:
    seen: set[int] = set()
    indexes: list[int] = []
    for page_index in page_indexes:
        if page_index < 0 or page_index >= page_count or page_index in seen:
            continue
        seen.add(page_index)
        indexes.append(page_index)
    return indexes


def _normalize_parallelism(value: int) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return 1


def _ocr_page_run_stats(
    *,
    pages_attempted: int,
    pages_with_text: int,
    line_count: int,
    requested_parallelism: int,
    effective_parallelism: int,
    mode: str,
    fallback_to_serial: bool,
) -> dict[str, object]:
    return {
        "ocr_pages_attempted": float(pages_attempted),
        "ocr_pages_with_text": float(pages_with_text),
        "ocr_line_count": float(line_count),
        "ocr_parallelism_requested": float(requested_parallelism),
        "ocr_parallelism_effective": float(effective_parallelism),
        "ocr_parallel_mode": mode,
        "ocr_parallel_fallback_to_serial": float(fallback_to_serial),
    }


def _ocr_page_error(page_index: int, exc: Exception) -> dict[str, object]:
    return {
        "page_index": page_index,
        "reason": "ocr_backend_error",
        "detail": str(exc),
    }


def _render_scale() -> float:
    raw_value = os.environ.get("BUQUE_OCR_RENDER_SCALE", "").strip()
    if not raw_value:
        return _DEFAULT_RENDER_SCALE
    try:
        return max(0.25, min(4.0, float(raw_value)))
    except ValueError:
        return _DEFAULT_RENDER_SCALE


def _render_page_png(page: fitz.Page, *, render_scale: float) -> bytes:
    pixmap = page.get_pixmap(matrix=fitz.Matrix(render_scale, render_scale), alpha=False)
    return pixmap.tobytes("png")


def _coerce_ocr_lines(
    raw_lines: list[OCRLine],
    *,
    page_height: float,
    render_scale: float,
) -> list[_OCRLine]:
    lines: list[_OCRLine] = []
    for index, raw_line in enumerate(raw_lines):
        if isinstance(raw_line, OCRTextLine):
            text = normalize_title(raw_line.text)
            if not text:
                continue
            bbox = _scale_bbox(raw_line.bbox, render_scale=render_scale) if raw_line.bbox else _synthetic_bbox(index, page_height)
            lines.append(_OCRLine(text=text, bbox=bbox, confidence=raw_line.confidence))
            continue

        text = normalize_title(str(raw_line))
        if not text:
            continue
        lines.append(_OCRLine(text=text, bbox=_synthetic_bbox(index, page_height)))

    lines.sort(key=lambda item: (item.bbox[1], item.bbox[0]))
    return lines


def _scale_bbox(
    bbox: tuple[float, float, float, float],
    *,
    render_scale: float,
) -> tuple[float, float, float, float]:
    return tuple(value / render_scale for value in bbox)  # type: ignore[return-value]


def _lines_to_candidates(
    *,
    lines: list[_OCRLine],
    page_index: int,
    page_height: float,
    body_line_height: float,
    rules: RuleConfig,
    score_weights: ScoreWeights,
) -> list[CandidateHeading]:
    candidates: list[CandidateHeading] = []
    page_candidate_count = 0
    for line in _expand_heading_fragments(lines):
        text = normalize_title(line.text)
        if _is_noise_title(text):
            continue
        if len(text) < rules.min_line_chars or len(text) > rules.max_line_chars:
            continue

        pattern = pattern_score(text)
        semantic = semantic_score(text)
        top_ratio = _top_ratio(line.bbox, page_height=page_height)
        style = _ocr_style_score(
            line=line,
            body_line_height=body_line_height,
            pattern=pattern,
            semantic=semantic,
            top_ratio=top_ratio,
        )
        if not _is_candidate_fragment(
            text=text,
            style=style,
            pattern=pattern,
            semantic=semantic,
            top_ratio=top_ratio,
            rules=rules,
        ):
            continue
        if page_candidate_count >= rules.max_candidates_per_page:
            break

        position = position_score(top_ratio)
        score = total_score(
            weights=score_weights,
            style=style,
            position=position,
            pattern=pattern,
            semantic=semantic,
        )
        level_hint = infer_numbered_level(text) or 1
        candidates.append(
            CandidateHeading(
                page_index=page_index,
                text=text,
                bbox=line.bbox,
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


def _expand_heading_fragments(lines: list[_OCRLine]) -> list[_OCRLine]:
    fragments: list[_OCRLine] = []
    skip_indexes: set[int] = set()
    for index, line in enumerate(lines):
        if index + 1 >= len(lines):
            continue
        next_line = lines[index + 1]
        if index + 2 < len(lines) and _should_combine_heading(line, next_line):
            third_line = lines[index + 2]
            if _should_extend_heading(line, next_line, third_line):
                fragments.append(_combine_lines(_combine_lines(line, next_line), third_line))
                skip_indexes.add(index)
                skip_indexes.add(index + 1)
                continue
        if _should_combine_heading(line, next_line):
            fragments.append(_combine_lines(line, next_line))
            skip_indexes.add(index)

    for index, line in enumerate(lines):
        if index not in skip_indexes:
            fragments.append(line)

    fragments.sort(key=lambda item: (item.bbox[1], item.bbox[0], len(item.text)))
    return fragments


def _should_combine_heading(line: _OCRLine, next_line: _OCRLine) -> bool:
    text = _compact_title(line.text)
    next_text = _compact_title(next_line.text)
    if not text or not next_text or len(next_text) > 28:
        return False
    if next_line.bbox[1] - line.bbox[3] > max(36.0, line.height * 1.8):
        return False
    if _HEADING_PREFIX_RE.match(text):
        return True
    return False


def _should_extend_heading(first: _OCRLine, second: _OCRLine, third: _OCRLine) -> bool:
    third_text = _compact_title(third.text)
    if not third_text or len(third_text) > 24:
        return False
    if third.bbox[1] - second.bbox[3] > max(36.0, second.height * 1.8):
        return False
    second_text = _compact_title(second.text)
    return "之一" in second_text or "之二" in second_text


def _combine_lines(first: _OCRLine, second: _OCRLine) -> _OCRLine:
    text = _join_title_parts(first.text, second.text)
    return _OCRLine(
        text=text,
        bbox=_union_bbox(first.bbox, second.bbox),
        confidence=_avg_confidence(first.confidence, second.confidence),
    )


def _join_title_parts(first: str, second: str) -> str:
    left = first.strip()
    right = second.strip()
    if _contains_cjk(left) or _contains_cjk(right):
        return f"{left}{right}"
    return f"{left} {right}"


def _contains_cjk(value: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in value)


def _compact_title(value: str) -> str:
    return re.sub(r"\s+", "", value)


def _union_bbox(
    first: tuple[float, float, float, float],
    second: tuple[float, float, float, float],
) -> tuple[float, float, float, float]:
    return (
        min(first[0], second[0]),
        min(first[1], second[1]),
        max(first[2], second[2]),
        max(first[3], second[3]),
    )


def _avg_confidence(first: float | None, second: float | None) -> float | None:
    values = [value for value in (first, second) if value is not None]
    if not values:
        return None
    return sum(values) / len(values)


def _is_candidate_fragment(
    *,
    text: str,
    style: float,
    pattern: float,
    semantic: float,
    top_ratio: float,
    rules: RuleConfig,
) -> bool:
    if pattern >= rules.min_pattern_candidate:
        return True
    if semantic >= rules.min_semantic_candidate and top_ratio <= 0.45 and len(text) <= 40:
        return True
    return style >= rules.min_style_candidate and top_ratio <= 0.35 and len(text) <= 40


def _is_noise_title(text: str) -> bool:
    compact = _compact_title(text)
    if not compact:
        return True
    if compact.isdigit():
        return True
    cjk_count = sum(1 for char in compact if "\u4e00" <= char <= "\u9fff")
    alpha_count = sum(1 for char in compact if char.isalpha())
    return len(compact) >= 4 and cjk_count == 0 and alpha_count == 0


def _top_ratio(bbox: tuple[float, float, float, float], *, page_height: float) -> float:
    if page_height <= 0:
        return 1.0
    return max(0.0, min(1.0, bbox[1] / page_height))


def _estimate_body_line_height(lines: Iterable[_OCRLine]) -> float:
    heights = [line.height for line in lines if 6.0 <= line.height <= 32.0]
    if not heights:
        return 12.0
    return float(median(heights))


def _ocr_style_score(
    *,
    line: _OCRLine,
    body_line_height: float,
    pattern: float,
    semantic: float,
    top_ratio: float,
) -> float:
    baseline = body_line_height if body_line_height > 0 else max(line.height, 1.0)
    size_component = _clamp((line.height / baseline - 1.0) / 1.2)
    prior = _ocr_style_prior(pattern=pattern, semantic=semantic, top_ratio=top_ratio)
    confidence_component = 0.0
    if line.confidence is not None:
        confidence_component = _clamp((line.confidence - 0.80) / 0.2) * 0.1
    return _clamp(max(prior, size_component) + confidence_component)


def _apply_ocr_contextual_levels(candidates: list[CandidateHeading]) -> None:
    seen_volume = False
    for candidate in sorted(candidates, key=lambda item: (item.page_index, item.bbox[1], item.bbox[0])):
        title = _compact_title(candidate.text)
        if _CHINESE_VOLUME_TITLE_RE.match(title):
            seen_volume = True
            candidate.level_hint = 1
        elif seen_volume and _CHINESE_CHAPTER_TITLE_RE.match(title):
            candidate.level_hint = max(candidate.level_hint or 1, 2)


def _synthetic_bbox(line_index: int, page_height: float) -> tuple[float, float, float, float]:
    y = max(0.0, min(page_height - 1.0, 72.0 + line_index * 18.0))
    return (72.0, y, 540.0, y + 12.0)


def _ocr_style_prior(*, pattern: float, semantic: float, top_ratio: float) -> float:
    if pattern >= 1.0:
        return 0.6
    if semantic >= 0.5 and top_ratio <= 0.4:
        return 0.5
    return 0.0


def _clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return max(minimum, min(maximum, value))


def _env_bool(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}
