from __future__ import annotations


class NoopOCRBackend:
    """M1 placeholder backend for OCR."""

    def extract(self, *, page_image_bytes: bytes, lang: str) -> list[str]:
        del page_image_bytes, lang
        return []
