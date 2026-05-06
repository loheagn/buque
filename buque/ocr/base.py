from __future__ import annotations

from typing import Protocol


class OCRBackend(Protocol):
    def extract(self, *, page_image_bytes: bytes, lang: str) -> list[str]:
        """Extract text lines from a page image."""
