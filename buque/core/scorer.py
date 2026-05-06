from __future__ import annotations

import re

from buque.core.config import ScoreWeights

_CHINESE_CHAPTER_RE = re.compile(r"^\s*第[零一二三四五六七八九十百千万〇\d]+章")
_CHINESE_SECTION_RE = re.compile(r"^\s*第[零一二三四五六七八九十百千万〇\d]+节")
_ENGLISH_CHAPTER_RE = re.compile(r"^\s*chapter\s+\d+\b", flags=re.IGNORECASE)
_ENGLISH_SECTION_RE = re.compile(r"^\s*section\s+\d+\b", flags=re.IGNORECASE)
_APPENDIX_RE = re.compile(r"^\s*(附录|appendix)\b", flags=re.IGNORECASE)
_DECIMAL_HEADING_RE = re.compile(r"^\s*(\d+(?:\.\d+){0,5})(?:\s+|$)")

_SEMANTIC_KEYWORDS = {
    "前言",
    "序",
    "绪论",
    "引言",
    "目录",
    "附录",
    "参考文献",
    "总结",
    "abstract",
    "contents",
    "appendix",
}

_SPACES_RE = re.compile(r"\s+")


def normalize_title(text: str) -> str:
    return _SPACES_RE.sub(" ", text.strip())


def position_score(top_ratio: float) -> float:
    ratio = max(0.0, min(1.0, top_ratio))
    if ratio <= 0.20:
        return 1.0
    if ratio <= 0.40:
        return 0.6
    if ratio <= 0.60:
        return 0.3
    return 0.1


def pattern_score(text: str) -> float:
    value = normalize_title(text)
    if not value:
        return 0.0
    if _CHINESE_CHAPTER_RE.match(value) or _ENGLISH_CHAPTER_RE.match(value) or _APPENDIX_RE.match(value):
        return 1.0
    if _CHINESE_SECTION_RE.match(value) or _ENGLISH_SECTION_RE.match(value):
        return 0.9
    if _DECIMAL_HEADING_RE.match(value):
        return 1.0
    return 0.0


def semantic_score(text: str) -> float:
    value = normalize_title(text).lower()
    if not value:
        return 0.0
    return 0.6 if any(keyword in value for keyword in _SEMANTIC_KEYWORDS) else 0.0


def infer_numbered_level(text: str) -> int | None:
    value = normalize_title(text)
    if not value:
        return None
    if _CHINESE_CHAPTER_RE.match(value) or _ENGLISH_CHAPTER_RE.match(value) or _APPENDIX_RE.match(value):
        return 1
    if _CHINESE_SECTION_RE.match(value) or _ENGLISH_SECTION_RE.match(value):
        return 2
    matched = _DECIMAL_HEADING_RE.match(value)
    if not matched:
        return None
    numbering = matched.group(1)
    level = len(numbering.split("."))
    return max(1, min(6, level))


def style_score(
    *,
    font_size: float,
    body_font_size: float,
    is_bold: bool,
    font_changed: bool,
) -> float:
    baseline = body_font_size if body_font_size > 0 else font_size
    ratio = 1.0 if baseline <= 0 else font_size / baseline
    size_component = _clamp((ratio - 1.0) / 0.55)
    bold_component = 1.0 if is_bold else 0.0
    font_component = 1.0 if font_changed else 0.0
    return _clamp(0.6 * size_component + 0.3 * bold_component + 0.1 * font_component)


def total_score(
    *,
    weights: ScoreWeights,
    style: float,
    position: float,
    pattern: float,
    semantic: float,
) -> float:
    return _clamp(
        weights.style * style
        + weights.position * position
        + weights.pattern * pattern
        + weights.semantic * semantic
    )


def _clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return max(minimum, min(maximum, value))
