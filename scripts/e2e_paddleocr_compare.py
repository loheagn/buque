from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from pathlib import Path

import fitz

from buque.core.pipeline import run_add_bookmarks
from buque.ocr.paddle import PaddleOCRBackend


@dataclass(slots=True)
class Match:
    reference_title: str
    reference_page: int
    generated_title: str | None
    generated_page: int | None
    title_similarity: float
    page_delta: int | None
    matched: bool


def main() -> None:
    parser = argparse.ArgumentParser(description="Run and compare PaddleOCR E2E bookmark generation.")
    parser.add_argument("--source", type=Path, default=Path("test-with-toc.pdf"))
    parser.add_argument("--workdir", type=Path, default=Path("artifacts/e2e-paddleocr"))
    parser.add_argument("--ocr-version", default="PP-OCRv5")
    parser.add_argument("--ocr-strategy", default="toc-guided", choices=["full-page", "toc-guided"])
    parser.add_argument("--ocr-parallelism", type=int, default=1)
    parser.add_argument("--lang", default="ch")
    parser.add_argument("--skip-run", action="store_true")
    args = parser.parse_args()

    args.workdir.mkdir(parents=True, exist_ok=True)
    suffix = args.ocr_version if args.ocr_strategy == "full-page" else f"{args.ocr_version}-{args.ocr_strategy}"
    original_toc_path = args.workdir / "original-toc.json"
    stripped_pdf_path = args.workdir / "test-no-toc.pdf"
    generated_pdf_path = args.workdir / f"generated-{suffix}.pdf"
    generated_toc_path = args.workdir / f"generated-{suffix}-toc.json"
    report_path = args.workdir / f"generated-{suffix}-report.json"
    comparison_path = args.workdir / f"comparison-{suffix}.json"
    summary_path = args.workdir / f"comparison-{suffix}.md"

    original_toc = prepare_inputs(
        source=args.source,
        stripped_pdf_path=stripped_pdf_path,
        original_toc_path=original_toc_path,
    )

    if not args.skip_run:
        backend = PaddleOCRBackend(ocr_version=args.ocr_version, lang=args.lang)
        result = run_add_bookmarks(
            input_path=stripped_pdf_path,
            output_path=generated_pdf_path,
            report_path=report_path,
            toc_json_path=generated_toc_path,
            lang=args.lang,
            enable_ocr=True,
            enable_llm=False,
            ocr_backend=backend,
            ocr_strategy=args.ocr_strategy,
            ocr_parallelism=args.ocr_parallelism,
        )
        if result.exit_code != 0:
            raise SystemExit(f"E2E run failed: {result.message}")

    generated_toc = json.loads(generated_toc_path.read_text(encoding="utf-8"))
    comparison = compare_tocs(original_toc, generated_toc)
    comparison_path.write_text(json.dumps(comparison, ensure_ascii=False, indent=2), encoding="utf-8")
    summary_path.write_text(render_summary(comparison, suffix), encoding="utf-8")
    print(summary_path)


def prepare_inputs(*, source: Path, stripped_pdf_path: Path, original_toc_path: Path) -> list[dict[str, object]]:
    with fitz.open(source) as doc:
        original_toc = [
            {
                "level": level,
                "title": title.strip(),
                "page": page,
                "page_index": page - 1,
            }
            for level, title, page, _dest in doc.get_toc(simple=False)
        ]
        original_toc_path.write_text(json.dumps(original_toc, ensure_ascii=False, indent=2), encoding="utf-8")
        if not stripped_pdf_path.exists():
            doc.set_toc([])
            doc.save(stripped_pdf_path, garbage=4, deflate=True)

    return original_toc


def compare_tocs(
    reference: list[dict[str, object]],
    generated: list[dict[str, object]],
    *,
    title_threshold: float = 0.72,
    page_tolerance: int = 2,
) -> dict[str, object]:
    matches: list[Match] = []
    used_generated: set[int] = set()
    for ref in reference:
        best_index: int | None = None
        best_score = -1.0
        best_similarity = 0.0
        best_page_delta: int | None = None
        ref_title = str(ref["title"])
        ref_page = int(ref["page"])
        for index, item in enumerate(generated):
            if index in used_generated:
                continue
            generated_page = int(item["page_index"]) + 1
            page_delta = abs(generated_page - ref_page)
            similarity = title_similarity(ref_title, str(item["title"]))
            page_score = max(0.0, 1.0 - page_delta / max(page_tolerance + 1, 1))
            score = 0.75 * similarity + 0.25 * page_score
            if score > best_score:
                best_index = index
                best_score = score
                best_similarity = similarity
                best_page_delta = page_delta

        if best_index is None:
            matches.append(Match(ref_title, ref_page, None, None, 0.0, None, False))
            continue

        best = generated[best_index]
        matched = best_similarity >= title_threshold and (best_page_delta or 0) <= page_tolerance
        if matched:
            used_generated.add(best_index)
        matches.append(
            Match(
                reference_title=ref_title,
                reference_page=ref_page,
                generated_title=str(best["title"]),
                generated_page=int(best["page_index"]) + 1,
                title_similarity=round(best_similarity, 4),
                page_delta=best_page_delta,
                matched=matched,
            )
        )

    matched_count = sum(1 for match in matches if match.matched)
    precision = matched_count / len(generated) if generated else 0.0
    recall = matched_count / len(reference) if reference else 0.0
    f1 = 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)
    return {
        "reference_count": len(reference),
        "generated_count": len(generated),
        "matched_count": matched_count,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "matches": [asdict(match) for match in matches],
        "unmatched_generated": [
            {
                "title": str(item["title"]),
                "page": int(item["page_index"]) + 1,
            }
            for index, item in enumerate(generated)
            if index not in used_generated
        ],
    }


def render_summary(comparison: dict[str, object], ocr_version: str) -> str:
    lines = [
        f"# PaddleOCR {ocr_version} E2E comparison",
        "",
        f"- Reference bookmarks: {comparison['reference_count']}",
        f"- Generated bookmarks: {comparison['generated_count']}",
        f"- Matched bookmarks: {comparison['matched_count']}",
        f"- Precision: {comparison['precision']}",
        f"- Recall: {comparison['recall']}",
        f"- F1: {comparison['f1']}",
        "",
        "## Missed reference bookmarks",
    ]
    for item in comparison["matches"]:
        if item["matched"]:
            continue
        lines.append(
            f"- p{item['reference_page']}: {item['reference_title']} "
            f"(best: p{item['generated_page']} {item['generated_title']}, sim={item['title_similarity']})"
        )
    lines.append("")
    lines.append("## Extra generated bookmarks")
    for item in comparison["unmatched_generated"]:
        lines.append(f"- p{item['page']}: {item['title']}")
    lines.append("")
    return "\n".join(lines)


def title_similarity(left: str, right: str) -> float:
    left_norm = normalize_for_match(left)
    right_norm = normalize_for_match(right)
    if not left_norm or not right_norm:
        return 0.0
    if left_norm in right_norm or right_norm in left_norm:
        return min(len(left_norm), len(right_norm)) / max(len(left_norm), len(right_norm))
    return SequenceMatcher(None, left_norm, right_norm).ratio()


def normalize_for_match(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[\s　!！?？:：,，.。;；、·《》“”\"'()（）\[\]【】\-—_]", "", value)
    return value


if __name__ == "__main__":
    main()
