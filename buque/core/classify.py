from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

import fitz

DocumentType = Literal["text", "scanned", "hybrid"]

_WHITESPACE_RE = re.compile(r"\s+")


@dataclass(slots=True)
class ClassificationResult:
    doc_type: DocumentType
    page_count: int
    text_pages: int
    text_page_ratio: float
    page_char_counts: list[int]


def classify_document(
    doc: fitz.Document,
    *,
    text_ratio_high: float,
    text_ratio_low: float,
    min_text_chars_per_page: int,
) -> ClassificationResult:
    page_char_counts: list[int] = []
    text_pages = 0
    for page in doc:
        raw = page.get_text("text")
        char_count = len(_WHITESPACE_RE.sub("", raw))
        page_char_counts.append(char_count)
        if char_count >= min_text_chars_per_page:
            text_pages += 1

    page_count = len(page_char_counts)
    ratio = 0.0 if page_count == 0 else text_pages / page_count
    if ratio >= text_ratio_high:
        doc_type: DocumentType = "text"
    elif ratio <= text_ratio_low:
        doc_type = "scanned"
    else:
        doc_type = "hybrid"

    return ClassificationResult(
        doc_type=doc_type,
        page_count=page_count,
        text_pages=text_pages,
        text_page_ratio=ratio,
        page_char_counts=page_char_counts,
    )
