from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
import os
import re
from typing import Iterable

import fitz

from buque.core.models import TocNode
from buque.core.ocr_extract import (
    _OCRLine,
    _coerce_ocr_lines,
    _expand_heading_fragments,
    _render_page_png,
    _render_scale,
)
from buque.core.scorer import normalize_title
from buque.ocr import OCRBackend

_TOC_TITLE_RE = re.compile(r"^\s*目\s*录\s*$")
_GRAPH_TOC_TITLE_RE = re.compile(r"^\s*图\s*表\s*目\s*录\s*$")
_VOLUME_RE = re.compile(r"^第[零一二三四五六七八九十百千万〇\d]+卷")
_CHAPTER_RE = re.compile(r"^第[零一二三四五六七八九十百千万〇\d]+章")
_STRUCTURAL_RE = re.compile(
    r"^(绪论|尾声|后记|附录|第[零一二三四五六七八九十百千万〇\d]+[卷章])"
)
_PAGE_NUM_RE = re.compile(r"^\d{1,4}$")
_PUNCT_RE = re.compile(r"[\s　!！?？:：,，.。;；、·《》“”\"'()（）\[\]【】\-—_．…]+")
_RUNNING_HEADERS = {"目录", "世界文字发展史"}
_FRONT_TITLES = {
    "作者简介",
    "目录",
    "图表目录",
    "序言",
    "第二版序言",
    "第三版序言",
}


@dataclass(slots=True)
class TocGuidedResult:
    toc_nodes: list[TocNode]
    stats: dict[str, float]
    errors: list[dict[str, object]]


@dataclass(slots=True)
class _TocEntry:
    title: str
    level: int
    printed_page: int | None
    source_page_index: int
    y: float
    confidence: float


@dataclass(slots=True)
class _Match:
    similarity: float
    title: str
    page_index: int


class _OCRPageCache:
    def __init__(self, *, doc: fitz.Document, backend: OCRBackend, lang: str) -> None:
        self._doc = doc
        self._backend = backend
        self._lang = lang
        self._cache: dict[tuple[int, float], list[_OCRLine]] = {}
        self.errors: list[dict[str, object]] = []
        self.calls = 0
        self.unique_pages: set[int] = set()
        self.pages_with_text: set[int] = set()
        self.line_count = 0

    def get(self, page_index: int, *, render_scale: float) -> list[_OCRLine]:
        if page_index < 0 or page_index >= self._doc.page_count:
            return []
        key = (page_index, render_scale)
        if key in self._cache:
            return self._cache[key]

        self.calls += 1
        self.unique_pages.add(page_index)
        page = self._doc[page_index]
        if _env_bool("BUQUE_OCR_PROGRESS"):
            print(f"OCR page {page_index + 1}/{self._doc.page_count}", flush=True)
        try:
            raw_lines = self._backend.extract(
                page_image_bytes=_render_page_png(page, render_scale=render_scale),
                lang=self._lang,
            )
        except Exception as exc:  # pragma: no cover - backend-specific failures are reported.
            self.errors.append(
                {
                    "page_index": page_index,
                    "reason": "ocr_backend_error",
                    "detail": str(exc),
                }
            )
            self._cache[key] = []
            return []

        lines = _coerce_ocr_lines(
            raw_lines,
            page_height=float(page.rect.height),
            render_scale=render_scale,
        )
        self.line_count += len(lines)
        if lines:
            self.pages_with_text.add(page_index)
        self._cache[key] = lines
        return lines


def extract_toc_guided_nodes(
    doc: fitz.Document,
    *,
    backend: OCRBackend,
    lang: str,
) -> TocGuidedResult:
    toc_scale = _env_float("BUQUE_TOC_GUIDED_TOC_RENDER_SCALE", 2.0)
    target_scale = _env_float("BUQUE_TOC_GUIDED_TARGET_RENDER_SCALE", _render_scale())
    max_front_scan = _env_int("BUQUE_TOC_GUIDED_MAX_FRONT_SCAN", 60)
    offset_probe_pages = _env_int("BUQUE_TOC_GUIDED_OFFSET_PROBE_PAGES", 80)
    confirm_window = _env_int("BUQUE_TOC_GUIDED_CONFIRM_WINDOW", 0)
    tail_scan_pages = _env_int("BUQUE_TOC_GUIDED_TAIL_SCAN_PAGES", 8)

    cache = _OCRPageCache(doc=doc, backend=backend, lang=lang)
    toc_start: int | None = None
    toc_content_end: int | None = None
    toc_scan_end: int | None = None
    parsed_rows: list[_TocEntry] = []
    front_nodes: list[TocNode] = []

    scan_limit = min(doc.page_count, max_front_scan)
    for page_index in range(scan_limit):
        lines = cache.get(page_index, render_scale=toc_scale)
        page = doc[page_index]
        front_nodes.extend(_front_nodes_from_page(lines, page_index=page_index))

        if toc_start is None:
            if _has_main_toc_title(lines):
                toc_start = page_index
            else:
                continue

        if _has_graph_toc_title(lines) and page_index > toc_start:
            toc_content_end = page_index - 1
            toc_scan_end = page_index
            break

        page_entries = _parse_toc_page(
            lines,
            page_index=page_index,
            page_width=float(page.rect.width),
        )
        if page_entries:
            parsed_rows.extend(page_entries)
            toc_content_end = page_index
            toc_scan_end = page_index
            continue

        if toc_content_end is not None and page_index > toc_content_end:
            toc_scan_end = page_index - 1
            break

    errors: list[dict[str, object]] = [*cache.errors]
    if toc_start is None or toc_content_end is None:
        errors.append({"reason": "toc_guided_toc_not_found"})
        return _result([], cache=cache, errors=errors, extra_stats={})

    structural_entries = _assign_missing_printed_pages(_select_structural_entries(parsed_rows))
    if not structural_entries:
        errors.append({"reason": "toc_guided_no_structural_entries"})
        return _result(
            [],
            cache=cache,
            errors=errors,
            extra_stats={"toc_guided_toc_pages": float(toc_content_end - toc_start + 1)},
        )

    first_content_index, offset = _infer_page_offset(
        doc=doc,
        cache=cache,
        entries=structural_entries,
        start_page=(toc_scan_end if toc_scan_end is not None else toc_content_end) + 1,
        max_pages=offset_probe_pages,
        render_scale=target_scale,
    )
    if offset is None:
        first_printed = next((entry.printed_page for entry in structural_entries if entry.printed_page is not None), 1)
        offset = ((toc_scan_end if toc_scan_end is not None else toc_content_end) + 1) - first_printed
        errors.append({"reason": "toc_guided_offset_inferred_weakly", "offset": offset})

    preface_end = (
        first_content_index
        if first_content_index is not None
        else min(doc.page_count, (toc_scan_end or toc_content_end) + 1 + offset_probe_pages)
    )
    for page_index in range((toc_scan_end if toc_scan_end is not None else toc_content_end) + 1, min(preface_end, doc.page_count)):
        lines = cache.get(page_index, render_scale=target_scale)
        front_nodes.extend(_front_nodes_from_page(lines, page_index=page_index))

    main_nodes = _entries_to_nodes(
        doc=doc,
        cache=cache,
        entries=structural_entries,
        offset=offset,
        render_scale=target_scale,
        confirm_window=confirm_window,
    )

    tail_nodes: list[TocNode] = []
    if main_nodes:
        tail_start = main_nodes[-1].page_index
        tail_stop = min(doc.page_count, tail_start + tail_scan_pages + 1)
        for page_index in range(tail_start, tail_stop):
            lines = cache.get(page_index, render_scale=target_scale)
            tail_nodes.extend(_tail_nodes_from_page(lines, page_index=page_index, page=doc[page_index]))

    toc_nodes = _dedupe_nodes([*front_nodes, *main_nodes, *tail_nodes])
    return _result(
        toc_nodes,
        cache=cache,
        errors=errors,
        extra_stats={
            "toc_guided_toc_start_page": float(toc_start + 1),
            "toc_guided_toc_pages": float(toc_content_end - toc_start + 1),
            "toc_guided_parsed_rows": float(len(parsed_rows)),
            "toc_guided_structural_entries": float(len(structural_entries)),
            "toc_guided_page_offset": float(offset),
        },
    )


def _parse_toc_page(
    lines: list[_OCRLine],
    *,
    page_index: int,
    page_width: float,
) -> list[_TocEntry]:
    numbered_rows = _numbered_toc_rows(lines, page_index=page_index, page_width=page_width)
    volume_rows = _volume_rows_without_page_numbers(lines, page_index=page_index, page_width=page_width)
    rows = [*numbered_rows, *volume_rows]
    rows.sort(key=lambda row: (row.source_page_index, row.y, row.printed_page is None, row.title))
    return rows


def _numbered_toc_rows(
    lines: list[_OCRLine],
    *,
    page_index: int,
    page_width: float,
) -> list[_TocEntry]:
    rows: list[_TocEntry] = []
    for number_line in lines:
        page_number = _page_number(number_line, page_width=page_width)
        if page_number is None:
            continue
        parts = [
            line
            for line in lines
            if line is not number_line
            and not _is_right_page_number(line, page_width=page_width)
            and line.bbox[2] < number_line.bbox[0] - 4
            and _same_row(line, number_line)
            and not _is_running_header(line.text)
        ]
        title = _clean_title(_join_line_parts(parts))
        if not title:
            continue
        rows.append(
            _TocEntry(
                title=title,
                level=_entry_level(title),
                printed_page=page_number,
                source_page_index=page_index,
                y=number_line.bbox[1],
                confidence=_avg_confidence([number_line, *parts]),
            )
        )
    return rows


def _volume_rows_without_page_numbers(
    lines: list[_OCRLine],
    *,
    page_index: int,
    page_width: float,
) -> list[_TocEntry]:
    rows: list[_TocEntry] = []
    for cluster in _same_row_clusters(
        [
            line
            for line in lines
            if not _is_right_page_number(line, page_width=page_width)
            and not _is_running_header(line.text)
            and 0.18 <= _x_center(line) / max(page_width, 1.0) <= 0.82
        ]
    ):
        title = _clean_title(_join_line_parts(cluster))
        if not title or not _VOLUME_RE.match(_compact(title)):
            continue
        rows.append(
            _TocEntry(
                title=title,
                level=1,
                printed_page=None,
                source_page_index=page_index,
                y=min(line.bbox[1] for line in cluster),
                confidence=_avg_confidence(cluster),
            )
        )
    return rows


def _select_structural_entries(entries: Iterable[_TocEntry]) -> list[_TocEntry]:
    selected: list[_TocEntry] = []
    seen: set[str] = set()
    for entry in sorted(
        entries,
        key=lambda item: (item.source_page_index, item.y, item.printed_page is None, item.printed_page or 0),
    ):
        title = _clean_title(entry.title)
        compact = _compact(title)
        if not _STRUCTURAL_RE.match(compact):
            continue
        key = _structural_key(compact)
        if key in seen:
            continue
        seen.add(key)
        selected.append(
            _TocEntry(
                title=title,
                level=_entry_level(title),
                printed_page=entry.printed_page,
                source_page_index=entry.source_page_index,
                y=entry.y,
                confidence=entry.confidence,
            )
        )
    return selected


def _assign_missing_printed_pages(entries: list[_TocEntry]) -> list[_TocEntry]:
    resolved: list[_TocEntry] = []
    for index, entry in enumerate(entries):
        if entry.printed_page is not None:
            resolved.append(entry)
            continue
        next_printed = next((item.printed_page for item in entries[index + 1 :] if item.printed_page is not None), None)
        prev_printed = next((item.printed_page for item in reversed(entries[:index]) if item.printed_page is not None), None)
        printed_page = None
        if next_printed is not None and _VOLUME_RE.match(_compact(entry.title)):
            printed_page = max(1, next_printed - 2)
        elif prev_printed is not None:
            printed_page = prev_printed
        resolved.append(
            _TocEntry(
                title=entry.title,
                level=entry.level,
                printed_page=printed_page,
                source_page_index=entry.source_page_index,
                y=entry.y,
                confidence=entry.confidence,
            )
        )
    return resolved


def _infer_page_offset(
    *,
    doc: fitz.Document,
    cache: _OCRPageCache,
    entries: list[_TocEntry],
    start_page: int,
    max_pages: int,
    render_scale: float,
) -> tuple[int | None, int | None]:
    anchors = [entry for entry in entries if entry.printed_page is not None and _is_anchor_entry(entry.title)][:6]
    if not anchors:
        return None, None

    best: tuple[float, int, int] | None = None
    stop_page = min(doc.page_count, max(start_page, 0) + max_pages)
    for page_index in range(max(0, start_page), stop_page):
        lines = cache.get(page_index, render_scale=render_scale)
        for entry in anchors:
            match = _best_page_match(lines, title=entry.title, page=doc[page_index], page_index=page_index)
            if match.similarity < 0.62:
                continue
            offset = (page_index + 1) - int(entry.printed_page)
            score = match.similarity - 0.01 * anchors.index(entry)
            if best is None or score > best[0]:
                best = (score, page_index, offset)
        if best is not None and best[0] >= 0.86:
            break
    if best is None:
        return None, None
    return best[1], best[2]


def _entries_to_nodes(
    *,
    doc: fitz.Document,
    cache: _OCRPageCache,
    entries: list[_TocEntry],
    offset: int,
    render_scale: float,
    confirm_window: int,
) -> list[TocNode]:
    nodes: list[TocNode] = []
    for entry in entries:
        if entry.printed_page is None:
            continue
        predicted_index = int(entry.printed_page) + offset - 1
        candidate_indexes = [
            page_index
            for page_index in range(predicted_index - confirm_window, predicted_index + confirm_window + 1)
            if 0 <= page_index < doc.page_count
        ]
        best_match = _Match(similarity=0.0, title="", page_index=max(0, min(doc.page_count - 1, predicted_index)))
        best_score = -1.0
        for page_index in candidate_indexes:
            lines = cache.get(page_index, render_scale=render_scale)
            match = _best_page_match(lines, title=entry.title, page=doc[page_index], page_index=page_index)
            score = match.similarity - 0.02 * abs(page_index - predicted_index)
            if score > best_score:
                best_score = score
                best_match = match

        title = _prefer_confirmed_title(entry.title, best_match.title)
        nodes.append(
            TocNode(
                title=title,
                level=entry.level,
                page_index=best_match.page_index,
                confidence=max(0.5, min(0.95, 0.6 + 0.35 * best_match.similarity)),
                source="rule",
            )
        )
    return nodes


def _front_nodes_from_page(lines: list[_OCRLine], *, page_index: int) -> list[TocNode]:
    nodes: list[TocNode] = []
    for line in lines[:12]:
        compact = _compact(line.text)
        if compact == "目录" and line.bbox[1] < 60.0:
            continue
        if compact in _FRONT_TITLES:
            nodes.append(
                TocNode(
                    title=_display_title(line.text),
                    level=1,
                    page_index=page_index,
                    confidence=0.9,
                    source="rule",
                )
            )
    return nodes


def _tail_nodes_from_page(lines: list[_OCRLine], *, page_index: int, page: fitz.Page) -> list[TocNode]:
    nodes: list[TocNode] = []
    for title in _page_title_candidates(lines, page=page):
        compact = _compact(title)
        if compact in {"后记"} or compact.startswith("附录") or compact.endswith("目录"):
            nodes.append(
                TocNode(
                    title=_display_title(title),
                    level=1,
                    page_index=page_index,
                    confidence=0.82,
                    source="rule",
                )
            )
    return nodes


def _best_page_match(lines: list[_OCRLine], *, title: str, page: fitz.Page, page_index: int) -> _Match:
    best = _Match(similarity=0.0, title="", page_index=page_index)
    for candidate in _page_title_candidates(lines, page=page):
        similarity = _title_similarity(title, candidate)
        if similarity > best.similarity:
            best = _Match(similarity=similarity, title=candidate, page_index=page_index)
    return best


def _page_title_candidates(lines: list[_OCRLine], *, page: fitz.Page) -> list[str]:
    page_height = float(page.rect.height)
    page_width = float(page.rect.width)
    top_lines = [
        line
        for line in lines
        if line.bbox[1] / max(page_height, 1.0) <= 0.42
        and not _is_noise_text(line.text)
        and 0.08 <= _x_center(line) / max(page_width, 1.0) <= 0.92
    ]
    candidates: list[str] = []
    candidates.extend(_clean_title(line.text) for line in _expand_heading_fragments(top_lines))
    candidates.extend(_clean_title(_join_line_parts(cluster)) for cluster in _same_row_clusters(top_lines))

    for index, line in enumerate(top_lines):
        if index + 1 >= len(top_lines):
            continue
        first = _compact(line.text)
        if not _STRUCTURAL_RE.match(first):
            continue
        second = top_lines[index + 1]
        if second.bbox[1] - line.bbox[3] > max(44.0, line.height * 2.2):
            continue
        candidates.append(_clean_title(_join_line_parts([line, second])))

    seen: set[str] = set()
    result: list[str] = []
    for candidate in candidates:
        if not candidate or _is_noise_text(candidate):
            continue
        compact = _compact(candidate)
        if compact in seen:
            continue
        seen.add(compact)
        result.append(candidate)
    return result


def _dedupe_nodes(nodes: list[TocNode]) -> list[TocNode]:
    sorted_nodes = sorted(nodes, key=lambda item: (item.page_index, item.level, item.title))
    result: list[TocNode] = []
    for node in sorted_nodes:
        replacement_index: int | None = None
        duplicate = False
        for index, existing in enumerate(result):
            if abs(existing.page_index - node.page_index) > 0:
                continue
            similarity = _title_similarity(existing.title, node.title)
            if similarity >= 0.74 or _compact(existing.title) in _compact(node.title) or _compact(node.title) in _compact(existing.title):
                duplicate = True
                if len(_compact(node.title)) > len(_compact(existing.title)):
                    replacement_index = index
                break
        if replacement_index is not None:
            result[replacement_index] = node
        elif not duplicate:
            result.append(node)
    return result


def _result(
    toc_nodes: list[TocNode],
    *,
    cache: _OCRPageCache,
    errors: list[dict[str, object]],
    extra_stats: dict[str, float],
) -> TocGuidedResult:
    stats = {
        "ocr_pages_attempted": float(cache.calls),
        "ocr_unique_pages_attempted": float(len(cache.unique_pages)),
        "ocr_pages_with_text": float(len(cache.pages_with_text)),
        "ocr_line_count": float(cache.line_count),
        "ocr_candidate_count": float(len(toc_nodes)),
        "toc_guided_node_count": float(len(toc_nodes)),
    }
    stats.update(extra_stats)
    return TocGuidedResult(toc_nodes=toc_nodes, stats=stats, errors=errors)


def _has_main_toc_title(lines: list[_OCRLine]) -> bool:
    return any(_TOC_TITLE_RE.match(_compact(line.text)) for line in lines[:8])


def _has_graph_toc_title(lines: list[_OCRLine]) -> bool:
    return any(_GRAPH_TOC_TITLE_RE.match(_compact(line.text)) for line in lines[:8])


def _page_number(line: _OCRLine, *, page_width: float) -> int | None:
    if not _is_right_page_number(line, page_width=page_width):
        return None
    text = _compact(line.text)
    return int(text)


def _is_right_page_number(line: _OCRLine, *, page_width: float) -> bool:
    text = _compact(line.text)
    return bool(_PAGE_NUM_RE.match(text)) and line.bbox[0] / max(page_width, 1.0) >= 0.72


def _same_row(line: _OCRLine, other: _OCRLine) -> bool:
    return abs(_y_center(line) - _y_center(other)) <= max(8.0, min(line.height, other.height) * 0.9)


def _same_row_clusters(lines: Iterable[_OCRLine]) -> list[list[_OCRLine]]:
    clusters: list[list[_OCRLine]] = []
    for line in sorted(lines, key=lambda item: (_y_center(item), item.bbox[0])):
        for cluster in clusters:
            if abs(_y_center(cluster[0]) - _y_center(line)) <= max(8.0, line.height):
                cluster.append(line)
                break
        else:
            clusters.append([line])
    for cluster in clusters:
        cluster.sort(key=lambda item: item.bbox[0])
    return clusters


def _join_line_parts(lines: Iterable[_OCRLine]) -> str:
    parts = [normalize_title(line.text) for line in sorted(lines, key=lambda item: item.bbox[0]) if normalize_title(line.text)]
    if not parts:
        return ""
    return normalize_title("".join(parts))


def _clean_title(title: str) -> str:
    value = normalize_title(title)
    value = value.replace("：", ":")
    value = re.sub(r"^[一二三四五六七八九十]+(?=第?[^\d])", "", value)
    return normalize_title(value)


def _display_title(title: str) -> str:
    value = normalize_title(title).replace(":", "：")
    if _contains_cjk(value):
        value = re.sub(r"\s+", "", value)
    return value


def _prefer_confirmed_title(entry_title: str, confirmed_title: str) -> str:
    if not confirmed_title:
        return _display_title(entry_title)
    entry_compact = _compact(entry_title)
    confirmed_compact = _compact(confirmed_title)
    if entry_compact in {"附录", "后记"} and confirmed_compact.startswith(entry_compact):
        return _display_title(confirmed_title)
    if _VOLUME_RE.match(entry_compact) and confirmed_compact.startswith(entry_compact) and len(confirmed_compact) > len(entry_compact):
        return _display_title(confirmed_title)
    return _display_title(entry_title)


def _entry_level(title: str) -> int:
    compact = _compact(title)
    if _CHAPTER_RE.match(compact):
        return 2
    return 1


def _is_anchor_entry(title: str) -> bool:
    compact = _compact(title)
    return compact.startswith("绪论") or bool(_VOLUME_RE.match(compact) or _CHAPTER_RE.match(compact))


def _structural_key(title: str) -> str:
    if _VOLUME_RE.match(title):
        return _VOLUME_RE.match(title).group(0)  # type: ignore[union-attr]
    if _CHAPTER_RE.match(title):
        return _CHAPTER_RE.match(title).group(0)  # type: ignore[union-attr]
    if title.startswith("绪论"):
        return "绪论"
    if title.startswith("尾声"):
        return "尾声"
    if title.startswith("后记"):
        return "后记"
    if title.startswith("附录"):
        return "附录"
    return title


def _title_similarity(left: str, right: str) -> float:
    left_norm = _match_key(left)
    right_norm = _match_key(right)
    if not left_norm or not right_norm:
        return 0.0
    if left_norm in {"附录", "后记"} and right_norm.startswith(left_norm):
        return 0.9
    if left_norm in right_norm or right_norm in left_norm:
        return min(len(left_norm), len(right_norm)) / max(len(left_norm), len(right_norm))
    return SequenceMatcher(None, left_norm, right_norm).ratio()


def _match_key(value: str) -> str:
    return _PUNCT_RE.sub("", value.lower())


def _compact(value: str) -> str:
    return re.sub(r"\s+", "", normalize_title(value))


def _is_running_header(text: str) -> bool:
    return _compact(text) in _RUNNING_HEADERS


def _is_noise_text(text: str) -> bool:
    compact = _compact(text)
    if not compact or compact.isdigit() or compact in _RUNNING_HEADERS:
        return True
    if len(compact) == 1 and compact in "一二三四五六七八九十上下":
        return True
    return False


def _contains_cjk(value: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in value)


def _avg_confidence(lines: Iterable[_OCRLine]) -> float:
    values = [line.confidence for line in lines if line.confidence is not None]
    if not values:
        return 0.75
    return sum(values) / len(values)


def _x_center(line: _OCRLine) -> float:
    return (line.bbox[0] + line.bbox[2]) / 2.0


def _y_center(line: _OCRLine) -> float:
    return (line.bbox[1] + line.bbox[3]) / 2.0


def _env_bool(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw_value = os.environ.get(name, "").strip()
    if not raw_value:
        return default
    try:
        return max(0, int(raw_value))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw_value = os.environ.get(name, "").strip()
    if not raw_value:
        return default
    try:
        return max(0.25, min(4.0, float(raw_value)))
    except ValueError:
        return default
