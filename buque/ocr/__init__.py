from buque.ocr.base import OCRBackend, OCRLine, OCRTextLine
from buque.ocr.command import CommandOCRBackend
from buque.ocr.noop import NoopOCRBackend
from buque.ocr.paddle import PaddleOCRBackend

__all__ = [
    "CommandOCRBackend",
    "OCRBackend",
    "OCRLine",
    "OCRTextLine",
    "NoopOCRBackend",
    "PaddleOCRBackend",
]
