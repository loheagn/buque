from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(slots=True)
class OCRTextLine:
    text: str
    bbox: tuple[float, float, float, float] | None = None
    confidence: float | None = None


OCRLine = str | OCRTextLine


class OCRBackend(Protocol):
    def extract(self, *, page_image_bytes: bytes, lang: str) -> list[OCRLine]:
        """Extract text lines from a page image."""
