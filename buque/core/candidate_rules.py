from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass

from buque.core.config import RuleConfig, ScoreWeights
from buque.core.extract_text import TextLine
from buque.core.models import CandidateHeading
from buque.core.scorer import (
    infer_numbered_level,
    normalize_title,
    pattern_score,
    position_score,
    semantic_score,
    style_score,
    total_score,
)


@dataclass(slots=True)
class CandidateExtractionResult:
    candidates: list[CandidateHeading]
    rule_stats: dict[str, float]


@dataclass(slots=True)
class _ScoredLine:
    line: TextLine
    text: str
    style: float
    position: float
    pattern: float
    semantic: float
    total: float


def extract_candidates(
    lines: list[TextLine],
    *,
    rules: RuleConfig,
    score_weights: ScoreWeights,
) -> CandidateExtractionResult:
    if not lines:
        return CandidateExtractionResult(candidates=[], rule_stats=_empty_stats())

    body_font_size = _estimate_body_font_size(lines)
    body_font_name = _estimate_body_font_name(lines, body_font_size)
    page_candidate_counts: dict[int, int] = defaultdict(int)
    scored_lines: list[_ScoredLine] = []
    for line in lines:
        text = normalize_title(line.text)
        if len(text) < rules.min_line_chars or len(text) > rules.max_line_chars:
            continue

        style = style_score(
            font_size=line.font_size,
            body_font_size=body_font_size,
            is_bold=line.is_bold,
            font_changed=bool(body_font_name and line.font_name != body_font_name),
        )
        pattern = pattern_score(text)
        semantic = semantic_score(text)
        position = position_score(line.top_ratio)
        total = total_score(
            weights=score_weights,
            style=style,
            position=position,
            pattern=pattern,
            semantic=semantic,
        )
        if (
            style < rules.min_style_candidate
            and pattern < rules.min_pattern_candidate
            and semantic < rules.min_semantic_candidate
        ):
            continue

        if page_candidate_counts[line.page_index] >= rules.max_candidates_per_page:
            continue
        page_candidate_counts[line.page_index] += 1
        scored_lines.append(
            _ScoredLine(
                line=line,
                text=text,
                style=style,
                position=position,
                pattern=pattern,
                semantic=semantic,
                total=total,
            )
        )

    if not scored_lines:
        return CandidateExtractionResult(candidates=[], rule_stats=_empty_stats())

    size_to_level = _build_font_bucket(scored_lines)
    candidates: list[CandidateHeading] = []
    for scored in scored_lines:
        level_hint = infer_numbered_level(scored.text)
        if level_hint is None:
            level_hint = size_to_level.get(scored.line.font_size, 1)
        candidates.append(
            CandidateHeading(
                page_index=scored.line.page_index,
                text=scored.text,
                bbox=scored.line.bbox,
                source="text",
                style_score=scored.style,
                position_score=scored.position,
                pattern_score=scored.pattern,
                semantic_score=scored.semantic,
                total_score=scored.total,
                level_hint=max(1, min(6, level_hint)),
            )
        )

    stats = _summarize_rule_stats(scored_lines)
    return CandidateExtractionResult(candidates=candidates, rule_stats=stats)


def _estimate_body_font_size(lines: list[TextLine]) -> float:
    sizes = [line.font_size for line in lines if line.font_size > 0]
    if not sizes:
        return 12.0
    rounded_counts = Counter(round(size, 1) for size in sizes)
    body_size, _ = sorted(rounded_counts.items(), key=lambda item: (-item[1], item[0]))[0]
    return float(body_size)


def _estimate_body_font_name(lines: list[TextLine], body_font_size: float) -> str:
    candidates = [
        line.font_name
        for line in lines
        if abs(line.font_size - body_font_size) <= 1.0 and line.font_name
    ]
    if not candidates:
        return ""
    return Counter(candidates).most_common(1)[0][0]


def _build_font_bucket(scored_lines: list[_ScoredLine]) -> dict[float, int]:
    sizes = sorted({scored.line.font_size for scored in scored_lines}, reverse=True)
    if not sizes:
        return {}
    mapping: dict[float, int] = {}
    for idx, size in enumerate(sizes):
        mapping[size] = max(1, min(6, idx + 1))
    return mapping


def _summarize_rule_stats(scored_lines: list[_ScoredLine]) -> dict[str, float]:
    style_scores = [item.style for item in scored_lines]
    position_scores = [item.position for item in scored_lines]
    pattern_scores = [item.pattern for item in scored_lines]
    semantic_scores = [item.semantic for item in scored_lines]
    totals = [item.total for item in scored_lines]
    return {
        "avg_style_score": _avg(style_scores),
        "avg_position_score": _avg(position_scores),
        "avg_pattern_score": _avg(pattern_scores),
        "avg_semantic_score": _avg(semantic_scores),
        "avg_total_score": _avg(totals),
    }


def _empty_stats() -> dict[str, float]:
    return {
        "avg_style_score": 0.0,
        "avg_position_score": 0.0,
        "avg_pattern_score": 0.0,
        "avg_semantic_score": 0.0,
        "avg_total_score": 0.0,
    }


def _avg(values: list[float]) -> float:
    if not values:
        return 0.0
    return sum(values) / len(values)
