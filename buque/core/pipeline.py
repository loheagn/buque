from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import fitz

from buque.core.candidate_rules import extract_candidates
from buque.core.classify import classify_document
from buque.core.config import load_config
from buque.core.extract_text import extract_text_lines
from buque.core.models import CandidateHeading, TocNode
from buque.core.tree_builder import build_toc_nodes
from buque.core.writer import write_bookmarks


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
) -> PipelineResult:
    del lang  # M1 keeps language as API placeholder.
    report = _new_report(enable_ocr=enable_ocr, enable_llm=enable_llm)
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
            if classified.doc_type != "text":
                report["unsupported_doc_type"] = True
                report["errors"].append("unsupported_doc_type")
                if enable_ocr:
                    report["errors"].append("ocr_not_implemented_in_m1")
                return _finalize_result(
                    success=False,
                    exit_code=2,
                    message=f"Unsupported document type for M1: {classified.doc_type}.",
                    report=report,
                    toc_nodes=[],
                    report_path=report_path,
                    toc_path=toc_json_path,
                )

            lines = extract_text_lines(doc)
            extraction = extract_candidates(
                lines,
                rules=config.rules,
                score_weights=config.score_weights,
            )
            report["candidate_count"] = len(extraction.candidates)
            report["rule_stats"] = {
                **extraction.rule_stats,
                "threshold_high": config.thresholds.high,
            }

            accepted, rejected_low = _split_candidates(
                extraction.candidates,
                high_threshold=config.thresholds.high,
            )
            tree_result = build_toc_nodes(accepted, max_level_jump=config.thresholds.max_level_jump)
            toc_nodes = tree_result.toc_nodes

            report["accepted_count"] = len(toc_nodes)
            report["rejected_nodes"] = [*rejected_low, *tree_result.rejected_nodes]
            report["rejected_count"] = len(report["rejected_nodes"])

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
    if candidate.total_score >= high_threshold:
        return True
    return candidate.pattern_score >= 1.0 and candidate.style_score >= 0.5


def _new_report(*, enable_ocr: bool, enable_llm: bool) -> dict[str, Any]:
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
            "llm_executed": False,
        },
        "rejected_nodes": [],
    }


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
