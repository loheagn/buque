from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import fitz

from buque.core.candidate_rules import extract_candidates
from buque.core.classify import classify_document
from buque.core.config import RuleConfig, ScoreWeights, load_config
from buque.core.extract_text import extract_text_lines
from buque.core.models import CandidateHeading, TocNode
from buque.core.ocr_extract import OCRExtractionResult, extract_ocr_candidates
from buque.core.toc_guided import TocGuidedResult, extract_toc_guided_nodes
from buque.core.tree_builder import build_toc_nodes
from buque.core.writer import write_bookmarks
from buque.ocr import CommandOCRBackend, NoopOCRBackend, OCRBackend, PaddleOCRBackend


@dataclass(slots=True)
class PipelineResult:
    success: bool
    exit_code: int
    message: str
    report: dict[str, Any]
    toc_nodes: list[TocNode]


def run_add_bookmarks(
    *,
    input_path: Path,
    output_path: Path,
    report_path: Path,
    toc_json_path: Path,
    lang: str,
    enable_ocr: bool,
    enable_llm: bool,
    config_path: Path | None = None,
    ocr_backend: OCRBackend | None = None,
    ocr_strategy: str | None = None,
) -> PipelineResult:
    resolved_ocr_strategy = _resolve_ocr_strategy(ocr_strategy)
    report = _new_report(enable_ocr=enable_ocr, enable_llm=enable_llm, ocr_strategy=resolved_ocr_strategy)
    toc_nodes: list[TocNode] = []

    try:
        config = load_config(config_path)
        with fitz.open(input_path) as doc:
            if doc.needs_pass:
                return _finalize_error(
                    report=report,
                    report_path=report_path,
                    toc_path=toc_json_path,
                    exit_code=3,
                    message="Failed to process input PDF: encrypted or password-protected file.",
                    error_code="input_encrypted",
                )

            classified = classify_document(
                doc,
                text_ratio_high=config.thresholds.text_ratio_high,
                text_ratio_low=config.thresholds.text_ratio_low,
                min_text_chars_per_page=config.thresholds.min_text_chars_per_page,
            )
            report["doc_type"] = classified.doc_type
            report["page_count"] = classified.page_count
            report["text_page_ratio"] = classified.text_page_ratio
            report["text_pages"] = classified.text_pages
            force_ocr = enable_ocr and _env_bool("BUQUE_FORCE_OCR")
            report["feature_flags"]["force_ocr"] = force_ocr
            if classified.doc_type != "text" and not enable_ocr:
                report["unsupported_doc_type"] = True
                report["errors"].append("unsupported_doc_type")
                return _finalize_result(
                    success=False,
                    exit_code=2,
                    message=f"Unsupported document type without OCR: {classified.doc_type}.",
                    report=report,
                    toc_nodes=[],
                    report_path=report_path,
                    toc_path=toc_json_path,
                )

            backend = _resolve_ocr_backend(ocr_backend)
            if (force_ocr or classified.doc_type != "text") and isinstance(backend, NoopOCRBackend):
                report["unsupported_doc_type"] = True
                report["errors"].append("ocr_backend_unavailable")
                return _finalize_result(
                    success=False,
                    exit_code=2,
                    message="OCR was requested, but no OCR backend is configured.",
                    report=report,
                    toc_nodes=[],
                    report_path=report_path,
                    toc_path=toc_json_path,
                )

            if force_ocr:
                text_candidates, text_stats = [], _empty_rule_stats()
            else:
                text_candidates, text_stats = _extract_text_candidates(
                    doc=doc,
                    rules=config.rules,
                    score_weights=config.score_weights,
                )
            candidates = list(text_candidates)
            guided_toc_nodes: list[TocNode] | None = None
            rule_stats = {
                **text_stats,
                "threshold_high": config.thresholds.high,
                "text_candidate_count": float(len(text_candidates)),
            }

            if enable_ocr:
                ocr_page_indexes = _ocr_page_indexes(
                    doc_type=classified.doc_type,
                    page_char_counts=classified.page_char_counts,
                    min_text_chars_per_page=config.thresholds.min_text_chars_per_page,
                    force_ocr=force_ocr,
                )
                if ocr_page_indexes:
                    if resolved_ocr_strategy == "toc-guided":
                        guided_result = extract_toc_guided_nodes(
                            doc,
                            backend=backend,
                            lang=lang,
                        )
                        report["feature_flags"]["ocr_executed"] = True
                        report["feature_flags"]["toc_guided_executed"] = True
                        rule_stats.update(guided_result.stats)
                        _add_toc_guided_errors(report, guided_result)
                        if guided_result.toc_nodes:
                            guided_toc_nodes = guided_result.toc_nodes
                        elif not _env_bool("BUQUE_TOC_GUIDED_DISABLE_FALLBACK"):
                            report["errors"].append("toc_guided_fallback_full_page")
                            ocr_result = extract_ocr_candidates(
                                doc,
                                page_indexes=ocr_page_indexes,
                                backend=backend,
                                lang=lang,
                                rules=config.rules,
                                score_weights=config.score_weights,
                            )
                            candidates.extend(ocr_result.candidates)
                            rule_stats.update(ocr_result.stats)
                            _add_ocr_errors(report, ocr_result)
                    else:
                        ocr_result = extract_ocr_candidates(
                            doc,
                            page_indexes=ocr_page_indexes,
                            backend=backend,
                            lang=lang,
                            rules=config.rules,
                            score_weights=config.score_weights,
                        )
                        report["feature_flags"]["ocr_executed"] = True
                        candidates.extend(ocr_result.candidates)
                        rule_stats.update(ocr_result.stats)
                        _add_ocr_errors(report, ocr_result)

            report["rule_stats"] = rule_stats

            if guided_toc_nodes is not None:
                toc_nodes = guided_toc_nodes
                report["candidate_count"] = len(toc_nodes)
                report["accepted_count"] = len(toc_nodes)
                report["rejected_nodes"] = []
                report["rejected_count"] = 0
            else:
                report["candidate_count"] = len(candidates)
                accepted, rejected_low = _split_candidates(
                    candidates,
                    high_threshold=config.thresholds.high,
                )
                tree_result = build_toc_nodes(accepted, max_level_jump=config.thresholds.max_level_jump)
                toc_nodes = tree_result.toc_nodes

                report["accepted_count"] = len(toc_nodes)
                report["rejected_nodes"] = [*rejected_low, *tree_result.rejected_nodes]
                report["rejected_count"] = len(report["rejected_nodes"])

            if classified.doc_type != "text" and not candidates and guided_toc_nodes is None:
                report["errors"].append("ocr_no_candidates")
                return _finalize_result(
                    success=False,
                    exit_code=2,
                    message="OCR completed, but no bookmark candidates were detected.",
                    report=report,
                    toc_nodes=[],
                    report_path=report_path,
                    toc_path=toc_json_path,
                )

        write_bookmarks(input_path=input_path, output_path=output_path, toc_nodes=toc_nodes)
        return _finalize_result(
            success=True,
            exit_code=0,
            message=f"Bookmarks written to {output_path}",
            report=report,
            toc_nodes=toc_nodes,
            report_path=report_path,
            toc_path=toc_json_path,
        )
    except Exception as exc:  # pragma: no cover - defensive fallback
        return _finalize_error(
            report=report,
            report_path=report_path,
            toc_path=toc_json_path,
            exit_code=3,
            message=f"Failed to process input PDF: {exc}",
            error_code="processing_error",
        )


def _split_candidates(
    candidates: list[CandidateHeading],
    *,
    high_threshold: float,
) -> tuple[list[CandidateHeading], list[dict[str, object]]]:
    accepted: list[CandidateHeading] = []
    rejected: list[dict[str, object]] = []
    for candidate in candidates:
        if _is_high_confidence(candidate, high_threshold=high_threshold):
            accepted.append(candidate)
        else:
            rejected.append(
                {
                    "page_index": candidate.page_index,
                    "title": candidate.text,
                    "reason": "below_threshold",
                    "score": candidate.total_score,
                }
            )
    return accepted, rejected


def _is_high_confidence(candidate: CandidateHeading, *, high_threshold: float) -> bool:
    if candidate.source == "ocr":
        if candidate.semantic_score >= 0.6 and candidate.position_score >= 0.6 and candidate.total_score >= 0.5:
            return True
        return candidate.total_score >= max(high_threshold, 0.85)
    if candidate.total_score >= high_threshold:
        return True
    return candidate.pattern_score >= 1.0 and candidate.style_score >= 0.5


def _extract_text_candidates(
    *,
    doc: fitz.Document,
    rules: RuleConfig,
    score_weights: ScoreWeights,
) -> tuple[list[CandidateHeading], dict[str, float]]:
    lines = extract_text_lines(doc)
    extraction = extract_candidates(
        lines,
        rules=rules,
        score_weights=score_weights,
    )
    return extraction.candidates, extraction.rule_stats


def _resolve_ocr_backend(ocr_backend: OCRBackend | None) -> OCRBackend:
    if ocr_backend is not None:
        return ocr_backend
    if os.environ.get("BUQUE_OCR_BACKEND", "").strip().lower() == "paddleocr":
        return PaddleOCRBackend.from_environment()
    command_backend = CommandOCRBackend.from_environment()
    if command_backend is not None:
        return command_backend
    return NoopOCRBackend()


def _ocr_page_indexes(
    *,
    doc_type: str,
    page_char_counts: list[int],
    min_text_chars_per_page: int,
    force_ocr: bool = False,
) -> list[int]:
    if force_ocr:
        return list(range(len(page_char_counts)))
    if doc_type == "text":
        return []
    if doc_type == "scanned":
        return list(range(len(page_char_counts)))
    return [
        page_index
        for page_index, char_count in enumerate(page_char_counts)
        if char_count < min_text_chars_per_page
    ]


def _add_ocr_errors(report: dict[str, Any], ocr_result: OCRExtractionResult) -> None:
    if not ocr_result.errors:
        return
    report["ocr_errors"] = ocr_result.errors
    if "ocr_backend_error" not in report["errors"]:
        report["errors"].append("ocr_backend_error")


def _add_toc_guided_errors(report: dict[str, Any], guided_result: TocGuidedResult) -> None:
    if not guided_result.errors:
        return
    report["toc_guided_errors"] = guided_result.errors
    if any(error.get("reason") == "ocr_backend_error" for error in guided_result.errors):
        if "ocr_backend_error" not in report["errors"]:
            report["errors"].append("ocr_backend_error")


def _empty_rule_stats() -> dict[str, float]:
    return {
        "avg_style_score": 0.0,
        "avg_position_score": 0.0,
        "avg_pattern_score": 0.0,
        "avg_semantic_score": 0.0,
        "avg_total_score": 0.0,
    }


def _env_bool(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _new_report(*, enable_ocr: bool, enable_llm: bool, ocr_strategy: str) -> dict[str, Any]:
    return {
        "doc_type": None,
        "page_count": 0,
        "candidate_count": 0,
        "accepted_count": 0,
        "rejected_count": 0,
        "rule_stats": {},
        "errors": [],
        "llm_degraded": bool(enable_llm),
        "unsupported_doc_type": False,
        "feature_flags": {
            "enable_ocr": enable_ocr,
            "enable_llm": enable_llm,
            "ocr_executed": False,
            "ocr_strategy": ocr_strategy,
            "toc_guided_executed": False,
            "llm_executed": False,
        },
        "rejected_nodes": [],
    }


def _resolve_ocr_strategy(value: str | None) -> str:
    raw_value = (value or os.environ.get("BUQUE_OCR_STRATEGY", "") or "toc-guided").strip().lower()
    normalized = raw_value.replace("_", "-")
    return normalized if normalized in {"full-page", "toc-guided"} else "toc-guided"


def _finalize_error(
    *,
    report: dict[str, Any],
    report_path: Path,
    toc_path: Path,
    exit_code: int,
    message: str,
    error_code: str,
) -> PipelineResult:
    report["errors"].append(error_code)
    return _finalize_result(
        success=False,
        exit_code=exit_code,
        message=message,
        report=report,
        toc_nodes=[],
        report_path=report_path,
        toc_path=toc_path,
    )


def _finalize_result(
    *,
    success: bool,
    exit_code: int,
    message: str,
    report: dict[str, Any],
    toc_nodes: list[TocNode],
    report_path: Path,
    toc_path: Path,
) -> PipelineResult:
    _write_json(
        toc_path,
        [asdict(node) for node in toc_nodes],
    )
    _write_json(report_path, report)
    return PipelineResult(
        success=success,
        exit_code=exit_code,
        message=message,
        report=report,
        toc_nodes=toc_nodes,
    )


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
