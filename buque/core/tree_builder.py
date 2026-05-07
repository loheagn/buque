from __future__ import annotations

from dataclasses import dataclass
import re

from buque.core.models import CandidateHeading, TocNode
from buque.core.scorer import normalize_title

_STRUCTURAL_HEADING_RE = re.compile(r"^\s*(第[零一二三四五六七八九十百千万〇\d]+[卷章])")


@dataclass(slots=True)
class BuildTreeResult:
    toc_nodes: list[TocNode]
    rejected_nodes: list[dict[str, object]]


def build_toc_nodes(candidates: list[CandidateHeading], *, max_level_jump: int = 1) -> BuildTreeResult:
    sorted_candidates = sorted(candidates, key=lambda item: (item.page_index, item.bbox[1], item.bbox[0]))
    seen: set[tuple[int, str]] = set()
    toc_nodes: list[TocNode] = []
    rejected: list[dict[str, object]] = []
    seen_structural_keys: set[str] = set()
    prev_level: int | None = None
    for candidate in sorted_candidates:
        title = normalize_title(candidate.text)
        if not title:
            rejected.append(_reject(candidate, "empty_title"))
            continue

        dedupe_key = (candidate.page_index, title.lower())
        if dedupe_key in seen:
            rejected.append(_reject(candidate, "duplicate_same_page"))
            continue
        seen.add(dedupe_key)

        structural_key = _structural_key(title)
        if structural_key and structural_key in seen_structural_keys:
            rejected.append(_reject(candidate, "duplicate_structural_heading"))
            continue
        if structural_key:
            seen_structural_keys.add(structural_key)

        level = max(1, min(6, candidate.level_hint or 1))
        if prev_level is None and level > 1:
            level = 1
        if prev_level is not None and level > prev_level + max_level_jump:
            level = prev_level + max_level_jump
        prev_level = level

        toc_nodes.append(
            TocNode(
                title=title,
                level=level,
                page_index=max(0, candidate.page_index),
                confidence=max(0.0, min(1.0, candidate.total_score)),
                source="rule",
            )
        )

    return BuildTreeResult(toc_nodes=toc_nodes, rejected_nodes=rejected)


def _reject(candidate: CandidateHeading, reason: str) -> dict[str, object]:
    return {
        "page_index": candidate.page_index,
        "title": candidate.text,
        "reason": reason,
        "score": candidate.total_score,
    }


def _structural_key(title: str) -> str:
    matched = _STRUCTURAL_HEADING_RE.match(title.replace(" ", ""))
    if not matched:
        return ""
    return matched.group(1)
