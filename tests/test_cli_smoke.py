from __future__ import annotations

import json
from pathlib import Path

import fitz
from typer.testing import CliRunner

from buque.cli import app
from buque.core.pipeline import run_add_bookmarks
from buque.ocr import OCRLine, OCRTextLine

runner = CliRunner()


def _build_text_pdf(path: Path) -> None:
    doc = fitz.open()
    page1 = doc.new_page()
    page1.insert_text((72, 72), "Chapter 1 Introduction", fontsize=22)
    page1.insert_text((72, 120), "This is body text for chapter one.", fontsize=12)

    page2 = doc.new_page()
    page2.insert_text((72, 72), "1.1 Background", fontsize=18)
    page2.insert_text((72, 120), "Additional body text for section 1.1.", fontsize=12)
    page2.insert_text((72, 300), "1.2 Scope", fontsize=18)
    page2.insert_text((72, 348), "Additional body text for section 1.2.", fontsize=12)
    doc.save(path)
    doc.close()


def _build_scanned_like_pdf(path: Path) -> None:
    doc = fitz.open()
    page = doc.new_page()
    page.draw_rect(fitz.Rect(50, 50, 500, 700), color=(0, 0, 0), fill=(0.9, 0.9, 0.9))
    doc.save(path)
    doc.close()


def _build_hybrid_pdf(path: Path) -> None:
    doc = fitz.open()
    page1 = doc.new_page()
    page1.insert_text((72, 72), "Chapter 1 Text Page", fontsize=22)
    page1.insert_text((72, 120), "This page has enough extractable body text for classification.", fontsize=12)

    page2 = doc.new_page()
    page2.draw_rect(fitz.Rect(50, 50, 500, 700), color=(0, 0, 0), fill=(0.9, 0.9, 0.9))
    doc.save(path)
    doc.close()


class _StaticOCRBackend:
    def __init__(self, lines: list[OCRLine]) -> None:
        self.lines = lines
        self.calls = 0

    def extract(self, *, page_image_bytes: bytes, lang: str) -> list[OCRLine]:
        assert page_image_bytes
        assert lang
        self.calls += 1
        return self.lines


class _SequencedOCRBackend:
    def __init__(self, pages: list[list[OCRLine]]) -> None:
        self.pages = pages
        self.calls = 0

    def extract(self, *, page_image_bytes: bytes, lang: str) -> list[OCRLine]:
        assert page_image_bytes
        assert lang
        index = self.calls
        self.calls += 1
        if index >= len(self.pages):
            return []
        return self.pages[index]


def test_cli_add_bookmarks_smoke(tmp_path: Path) -> None:
    input_pdf = tmp_path / "book.pdf"
    output_pdf = tmp_path / "book.tagged.pdf"
    report_path = tmp_path / "report.json"
    toc_path = tmp_path / "toc.json"
    _build_text_pdf(input_pdf)

    result = runner.invoke(
        app,
        [
            "add-bookmarks",
            "--input",
            str(input_pdf),
            "--output",
            str(output_pdf),
            "--report",
            str(report_path),
            "--toc-json",
            str(toc_path),
        ],
    )
    assert result.exit_code == 0, result.output
    assert output_pdf.exists()
    assert report_path.exists()
    assert toc_path.exists()

    toc_payload = json.loads(toc_path.read_text(encoding="utf-8"))
    assert [node["title"] for node in toc_payload] == [
        "Chapter 1 Introduction",
        "1.1 Background",
        "1.2 Scope",
    ]
    assert [node["level"] for node in toc_payload] == [1, 2, 2]

    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["doc_type"] == "text"
    assert report["accepted_count"] == 3

    with fitz.open(output_pdf) as doc:
        toc_rows = doc.get_toc(simple=True)
    assert [row[1] for row in toc_rows] == [
        "Chapter 1 Introduction",
        "1.1 Background",
        "1.2 Scope",
    ]


def test_cli_rejects_scanned_document_in_m1(tmp_path: Path) -> None:
    input_pdf = tmp_path / "scan.pdf"
    output_pdf = tmp_path / "scan.tagged.pdf"
    report_path = tmp_path / "report.json"
    toc_path = tmp_path / "toc.json"
    _build_scanned_like_pdf(input_pdf)

    result = runner.invoke(
        app,
        [
            "add-bookmarks",
            "--input",
            str(input_pdf),
            "--output",
            str(output_pdf),
            "--report",
            str(report_path),
            "--toc-json",
            str(toc_path),
        ],
    )
    assert result.exit_code == 2
    assert not output_pdf.exists()
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["doc_type"] in {"scanned", "hybrid"}
    assert report["unsupported_doc_type"] is True


def test_pipeline_processes_scanned_document_with_ocr_backend(tmp_path: Path) -> None:
    input_pdf = tmp_path / "scan.pdf"
    output_pdf = tmp_path / "scan.tagged.pdf"
    report_path = tmp_path / "report.json"
    toc_path = tmp_path / "toc.json"
    _build_scanned_like_pdf(input_pdf)
    ocr_backend = _StaticOCRBackend(
        [
            OCRTextLine("Chapter 1 OCR", bbox=(80, 80, 420, 200), confidence=0.98),
            OCRTextLine("1.1 OCR Background", bbox=(80, 240, 420, 360), confidence=0.98),
            OCRTextLine("Plain body text", bbox=(80, 300, 420, 322), confidence=0.98),
        ]
    )

    result = run_add_bookmarks(
        input_path=input_pdf,
        output_path=output_pdf,
        report_path=report_path,
        toc_json_path=toc_path,
        lang="eng",
        enable_ocr=True,
        enable_llm=False,
        ocr_backend=ocr_backend,
        ocr_strategy="full-page",
    )

    assert result.exit_code == 0
    assert output_pdf.exists()
    assert ocr_backend.calls == 1
    toc_payload = json.loads(toc_path.read_text(encoding="utf-8"))
    assert [node["title"] for node in toc_payload] == ["Chapter 1 OCR", "1.1 OCR Background"]
    assert [node["level"] for node in toc_payload] == [1, 2]

    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["doc_type"] == "scanned"
    assert report["feature_flags"]["ocr_executed"] is True
    assert report["rule_stats"]["ocr_pages_attempted"] == 1
    assert report["accepted_count"] == 2


def test_pipeline_routes_only_sparse_pages_for_hybrid_ocr(tmp_path: Path) -> None:
    input_pdf = tmp_path / "hybrid.pdf"
    output_pdf = tmp_path / "hybrid.tagged.pdf"
    report_path = tmp_path / "report.json"
    toc_path = tmp_path / "toc.json"
    _build_hybrid_pdf(input_pdf)
    ocr_backend = _StaticOCRBackend(
        [OCRTextLine("1.1 Scanned Section", bbox=(80, 80, 420, 200), confidence=0.98)]
    )

    result = run_add_bookmarks(
        input_path=input_pdf,
        output_path=output_pdf,
        report_path=report_path,
        toc_json_path=toc_path,
        lang="eng",
        enable_ocr=True,
        enable_llm=False,
        ocr_backend=ocr_backend,
        ocr_strategy="full-page",
    )

    assert result.exit_code == 0
    assert ocr_backend.calls == 1
    toc_payload = json.loads(toc_path.read_text(encoding="utf-8"))
    assert [node["title"] for node in toc_payload] == ["Chapter 1 Text Page", "1.1 Scanned Section"]

    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["doc_type"] == "hybrid"
    assert report["text_pages"] == 1
    assert report["rule_stats"]["ocr_pages_attempted"] == 1


def test_pipeline_can_use_toc_guided_ocr_strategy(tmp_path: Path, monkeypatch) -> None:
    input_pdf = tmp_path / "scan.pdf"
    output_pdf = tmp_path / "scan.tagged.pdf"
    report_path = tmp_path / "report.json"
    toc_path = tmp_path / "toc.json"
    _build_scanned_like_pdf(input_pdf)
    with fitz.open(input_pdf) as doc:
        doc.new_page()
        doc.new_page()
        doc.saveIncr()

    monkeypatch.setenv("BUQUE_TOC_GUIDED_TARGET_RENDER_SCALE", "2")
    ocr_backend = _SequencedOCRBackend(
        [
            [],
            [
                OCRTextLine("目录", bbox=(260, 140, 340, 190), confidence=0.99),
                OCRTextLine("绪论测试", bbox=(180, 320, 340, 350), confidence=0.99),
                OCRTextLine("1", bbox=(920, 320, 940, 350), confidence=0.99),
            ],
            [
                OCRTextLine("绪论测试", bbox=(220, 180, 380, 230), confidence=0.99),
            ],
        ]
    )

    result = run_add_bookmarks(
        input_path=input_pdf,
        output_path=output_pdf,
        report_path=report_path,
        toc_json_path=toc_path,
        lang="zh",
        enable_ocr=True,
        enable_llm=False,
        ocr_backend=ocr_backend,
    )

    assert result.exit_code == 0
    toc_payload = json.loads(toc_path.read_text(encoding="utf-8"))
    assert [node["title"] for node in toc_payload] == ["目录", "绪论测试"]
    assert [node["page_index"] for node in toc_payload] == [1, 2]

    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["feature_flags"]["ocr_strategy"] == "toc-guided"
    assert report["feature_flags"]["toc_guided_executed"] is True
    assert report["rule_stats"]["toc_guided_page_offset"] == 2


def test_pipeline_default_toc_guided_falls_back_to_full_page(tmp_path: Path) -> None:
    input_pdf = tmp_path / "scan.pdf"
    output_pdf = tmp_path / "scan.tagged.pdf"
    report_path = tmp_path / "report.json"
    toc_path = tmp_path / "toc.json"
    _build_scanned_like_pdf(input_pdf)
    ocr_backend = _SequencedOCRBackend(
        [
            [],
            [
                OCRTextLine("Chapter 1 OCR", bbox=(80, 80, 420, 200), confidence=0.98),
            ],
        ]
    )

    result = run_add_bookmarks(
        input_path=input_pdf,
        output_path=output_pdf,
        report_path=report_path,
        toc_json_path=toc_path,
        lang="eng",
        enable_ocr=True,
        enable_llm=False,
        ocr_backend=ocr_backend,
    )

    assert result.exit_code == 0
    assert ocr_backend.calls == 2
    toc_payload = json.loads(toc_path.read_text(encoding="utf-8"))
    assert [node["title"] for node in toc_payload] == ["Chapter 1 OCR"]

    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["feature_flags"]["ocr_strategy"] == "toc-guided"
    assert report["feature_flags"]["toc_guided_executed"] is True
    assert "toc_guided_fallback_full_page" in report["errors"]
