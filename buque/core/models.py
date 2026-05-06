from dataclasses import dataclass
from typing import Literal, Optional


@dataclass(slots=True)
class CandidateHeading:
    page_index: int
    text: str
    bbox: tuple[float, float, float, float]
    source: Literal["text", "ocr"]
    style_score: float
    position_score: float
    pattern_score: float
    semantic_score: float
    total_score: float
    level_hint: Optional[int] = None


@dataclass(slots=True)
class TocNode:
    title: str
    level: int
    page_index: int
    confidence: float
    source: Literal["rule", "llm", "merged"]
