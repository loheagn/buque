from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from buque.ocr.base import OCRBackend
from buque.ocr.command import CommandOCRBackend
from buque.ocr.noop import NoopOCRBackend
from buque.ocr.paddle import PaddleOCRBackend


@dataclass(frozen=True, slots=True)
class OCRBackendSpec:
    kind: Literal["command", "noop", "paddle"]
    options: dict[str, Any]


def backend_to_spec(backend: OCRBackend) -> OCRBackendSpec | None:
    if isinstance(backend, CommandOCRBackend):
        return OCRBackendSpec(
            kind="command",
            options={
                "command_template": backend.command_template,
                "timeout_seconds": backend.timeout_seconds,
            },
        )
    if isinstance(backend, NoopOCRBackend):
        return OCRBackendSpec(kind="noop", options={})
    if isinstance(backend, PaddleOCRBackend):
        return OCRBackendSpec(
            kind="paddle",
            options={
                "ocr_version": backend.ocr_version,
                "lang": backend.lang,
                "text_detection_model_name": backend.text_detection_model_name,
                "text_recognition_model_name": backend.text_recognition_model_name,
                "use_doc_orientation_classify": backend.use_doc_orientation_classify,
                "use_doc_unwarping": backend.use_doc_unwarping,
                "use_textline_orientation": backend.use_textline_orientation,
            },
        )
    return None


def backend_from_spec(spec: OCRBackendSpec) -> OCRBackend:
    if spec.kind == "command":
        return CommandOCRBackend(
            command_template=str(spec.options["command_template"]),
            timeout_seconds=int(spec.options["timeout_seconds"]),
        )
    if spec.kind == "noop":
        return NoopOCRBackend()
    if spec.kind == "paddle":
        return PaddleOCRBackend(**spec.options)
    raise ValueError(f"Unsupported OCR backend spec: {spec.kind}")
