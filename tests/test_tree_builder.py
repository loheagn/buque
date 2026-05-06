from buque.core.models import CandidateHeading
from buque.core.tree_builder import build_toc_nodes


def _candidate(
    *,
    page_index: int,
    title: str,
    level_hint: int,
    y: float,
    score: float = 0.9,
) -> CandidateHeading:
    return CandidateHeading(
        page_index=page_index,
        text=title,
        bbox=(0.0, y, 100.0, y + 10.0),
        source="text",
        style_score=0.9,
        position_score=0.9,
        pattern_score=0.9,
        semantic_score=0.0,
        total_score=score,
        level_hint=level_hint,
    )


def test_tree_builder_dedup_and_level_jump_guard() -> None:
    candidates = [
        _candidate(page_index=0, title="Chapter 1", level_hint=1, y=10),
        _candidate(page_index=0, title="Chapter 1", level_hint=1, y=12),  # duplicate
        _candidate(page_index=1, title="Deep Section", level_hint=4, y=10),
    ]
    result = build_toc_nodes(candidates, max_level_jump=1)
    assert [node.title for node in result.toc_nodes] == ["Chapter 1", "Deep Section"]
    assert [node.level for node in result.toc_nodes] == [1, 2]
    assert len(result.rejected_nodes) == 1
    assert result.rejected_nodes[0]["reason"] == "duplicate_same_page"
