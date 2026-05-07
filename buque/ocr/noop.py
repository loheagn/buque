from __future__ import annotations


class NoopOCRBackend:
    """Placeholder backend used when OCR is not configured."""

    def extract(self, *, page_image_bytes: bytes, lang: str) -> list[str]:
        del page_image_bytes, lang
        return []
