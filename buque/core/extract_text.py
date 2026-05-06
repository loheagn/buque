from __future__ import annotations

from dataclasses import dataclass

import fitz


@dataclass(slots=True)
class TextLine:
    page_index: int
    text: str
    bbox: tuple[float, float, float, float]
    font_size: float
    is_bold: bool
    font_name: str
    page_height: float

    @property
    def top_ratio(self) -> float:
        if self.page_height <= 0:
            return 1.0
        return max(0.0, min(1.0, self.bbox[1] / self.page_height))


def extract_text_lines(doc: fitz.Document) -> list[TextLine]:
    lines: list[TextLine] = []
    for page_index, page in enumerate(doc):
        page_height = float(page.rect.height)
        page_dict = page.get_text("dict")
        for block in page_dict.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                if not spans:
                    continue
                text = "".join(str(span.get("text", "")) for span in spans).strip()
                if not text:
                    continue
                font_size = max(float(span.get("size", 0.0)) for span in spans)
                font_name = str(spans[0].get("font", ""))
                is_bold = any(
                    "bold" in str(span.get("font", "")).lower()
                    or (int(span.get("flags", 0)) & 16) != 0
                    for span in spans
                )
                raw_bbox = line.get("bbox") or block.get("bbox") or (0.0, 0.0, 0.0, 0.0)
                bbox = tuple(float(value) for value in raw_bbox)
                lines.append(
                    TextLine(
                        page_index=page_index,
                        text=text,
                        bbox=bbox,  # type: ignore[arg-type]
                        font_size=font_size,
                        is_bold=is_bold,
                        font_name=font_name,
                        page_height=page_height,
                    )
                )

    lines.sort(key=lambda item: (item.page_index, item.bbox[1], item.bbox[0]))
    return lines
