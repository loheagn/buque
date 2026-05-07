from __future__ import annotations

import os
import tempfile
from typing import Any

from buque.ocr.base import OCRLine, OCRTextLine


class PaddleOCRBackend:
    """Optional PaddleOCR backend loaded only when the dependency is installed."""

    def __init__(
        self,
        *,
        ocr_version: str = "PP-OCRv5",
        lang: str = "ch",
        text_detection_model_name: str | None = None,
        text_recognition_model_name: str | None = None,
        use_doc_orientation_classify: bool = False,
        use_doc_unwarping: bool = False,
        use_textline_orientation: bool = False,
    ) -> None:
        try:
            from paddleocr import PaddleOCR
        except ImportError as exc:  # pragma: no cover - depends on optional runtime.
            raise RuntimeError("PaddleOCR is not installed in the current Python environment.") from exc

        self.ocr_version = ocr_version
        self.lang = lang
        self._ocr = PaddleOCR(
            lang=lang,
            ocr_version=ocr_version,
            text_detection_model_name=text_detection_model_name,
            text_recognition_model_name=text_recognition_model_name,
            use_doc_orientation_classify=use_doc_orientation_classify,
            use_doc_unwarping=use_doc_unwarping,
            use_textline_orientation=use_textline_orientation,
        )

    @classmethod
    def from_environment(cls) -> "PaddleOCRBackend":
        return cls(
            ocr_version=os.environ.get("BUQUE_PADDLE_OCR_VERSION", "PP-OCRv5"),
            lang=os.environ.get("BUQUE_PADDLE_LANG", "ch"),
            text_detection_model_name=os.environ.get("BUQUE_PADDLE_TEXT_DETECTION_MODEL") or None,
            text_recognition_model_name=os.environ.get("BUQUE_PADDLE_TEXT_RECOGNITION_MODEL") or None,
            use_doc_orientation_classify=_env_bool("BUQUE_PADDLE_DOC_ORIENTATION"),
            use_doc_unwarping=_env_bool("BUQUE_PADDLE_DOC_UNWARPING"),
            use_textline_orientation=_env_bool("BUQUE_PADDLE_TEXTLINE_ORIENTATION"),
        )

    def extract(self, *, page_image_bytes: bytes, lang: str) -> list[OCRLine]:
        del lang  # The PaddleOCR pipeline language is fixed at construction time.
        with tempfile.NamedTemporaryFile(suffix=".png") as image_file:
            image_file.write(page_image_bytes)
            image_file.flush()
            results = self._ocr.predict(image_file.name)

        lines: list[OCRTextLine] = []
        for result in results:
            payload = _result_payload(result)
            texts = payload.get("rec_texts")
            boxes = payload.get("rec_boxes")
            scores = payload.get("rec_scores")
            texts = [] if texts is None else texts
            boxes = [] if boxes is None else boxes
            scores = [] if scores is None else scores
            for index, text in enumerate(texts):
                value = str(text).strip()
                if not value:
                    continue
                lines.append(
                    OCRTextLine(
                        text=value,
                        bbox=_box_at(boxes, index),
                        confidence=_score_at(scores, index),
                    )
                )

        lines.sort(key=lambda line: _sort_key(line.bbox))
        return lines


def _result_payload(result: Any) -> dict[str, Any]:
    if isinstance(result, dict):
        return result
    result_json = getattr(result, "json", None)
    if isinstance(result_json, dict):
        value = result_json.get("res", result_json)
        return value if isinstance(value, dict) else {}
    return {}


def _box_at(boxes: Any, index: int) -> tuple[float, float, float, float] | None:
    if boxes is None or index >= len(boxes):
        return None
    box = boxes[index]
    if hasattr(box, "tolist"):
        box = box.tolist()
    if not box:
        return None
    if len(box) == 4 and all(isinstance(value, (int, float)) for value in box):
        x0, y0, x1, y1 = box
        return (float(x0), float(y0), float(x1), float(y1))
    points = list(box)
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    return (min(xs), min(ys), max(xs), max(ys))


def _score_at(scores: Any, index: int) -> float | None:
    if scores is None or index >= len(scores):
        return None
    return float(scores[index])


def _sort_key(bbox: tuple[float, float, float, float] | None) -> tuple[float, float]:
    if bbox is None:
        return (0.0, 0.0)
    return (bbox[1], bbox[0])


def _env_bool(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}
