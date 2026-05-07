# Buque

For a Chinese version of this document, see [README.zh-CN.md](README.zh-CN.md).

Buque(补阙) is a PDF bookmark generation tool for books. The current release focuses on the M2 scope: detecting headings in text-based, scanned, and hybrid PDFs and writing them as PDF Outlines, which are the navigation bookmarks shown in most PDF readers.

Buque does not currently generate PDF/UA Tagged PDF structure tags. OCR-backed scanned-page routing is implemented for M2. LLM review interfaces are still reserved for later stages and are not implemented yet.

## Features

- Detect text-based, scanned, and hybrid PDFs.
- Extract text lines with font size, font name, bold flag, and page coordinates through PyMuPDF.
- Route scanned or sparse hybrid pages through an OCR backend when `--enable-ocr` is set.
- Score heading candidates using style, position, numbering pattern, and semantic keyword signals.
- Infer bookmark levels from chapter and section patterns such as `Chapter 1`, `Section 2`, `Appendix A`, and `1.2.3`.
- Build a deduplicated table of contents with simple level-jump protection.
- Write bookmarks back to a new PDF.
- Emit `toc.json` and `report.json` for inspection.

## Installation

This repository uses `uv`.

```bash
uv sync
```

Run the CLI from the workspace:

```bash
uv run buque --help
```

## Usage

```bash
uv run buque add-bookmarks \
  --input ./book.pdf \
  --output ./book.tagged.pdf \
  --report ./report.json \
  --toc-json ./toc.json
```

The command writes:

- `book.tagged.pdf`: output PDF with generated bookmarks.
- `toc.json`: generated bookmark nodes.
- `report.json`: document type, candidate counts, accepted and rejected counts, rule stats, and errors.

### OCR

Scanned and hybrid PDFs require `--enable-ocr` and an OCR backend. For CLI use, set `BUQUE_OCR_COMMAND` to a command that accepts an image path and language and writes one OCR text line per stdout line:

```bash
BUQUE_OCR_COMMAND='my-ocr-command' \
uv run buque add-bookmarks --enable-ocr --lang eng \
  --input ./scan.pdf \
  --output ./scan.bookmarked.pdf
```

If the command needs custom argument placement, use `{image}` and `{lang}` placeholders:

```bash
BUQUE_OCR_COMMAND='my-ocr-command --image {image} --lang {lang}'
```

When PaddleOCR is installed in the active Python environment, Buque can use it in-process:

```bash
BUQUE_OCR_BACKEND=paddleocr \
BUQUE_PADDLE_OCR_VERSION=PP-OCRv5 \
uv run buque add-bookmarks --enable-ocr --lang ch \
  --input ./scan.pdf \
  --output ./scan.bookmarked.pdf
```

For scanned PDFs that also contain a noisy hidden text layer, set `BUQUE_FORCE_OCR=1` to ignore extracted text and OCR every page. `BUQUE_OCR_RENDER_SCALE` can tune OCR image resolution; higher values are slower but may improve accuracy.

## Current Scope

M2 supports text-based PDFs directly. A PDF is treated as text-based when enough pages contain extractable text. Scanned PDFs and sparse pages in hybrid PDFs are processed through OCR when `--enable-ocr` is set and an OCR backend is configured; otherwise scanned and hybrid PDFs are rejected with exit code `2`.

The `--enable-llm` option is reserved for a later stage. Passing it records degraded LLM status in the report but does not call an LLM resolver.

## Development

Run tests:

```bash
uv run pytest
```

Build package artifacts:

```bash
uv build
```

## Project Layout

```text
buque/
  cli.py                  # Typer CLI
  core/
    classify.py           # Text/scanned/hybrid classification
    extract_text.py       # Text-line extraction via PyMuPDF
    ocr_extract.py        # OCR page rendering and candidate conversion
    candidate_rules.py    # Heading candidate extraction
    scorer.py             # Rule scores and level inference
    tree_builder.py       # TOC node construction
    writer.py             # PDF bookmark writing
  ocr/                    # OCR interfaces and command backend
  llm/                    # Placeholder LLM interface
tests/
  test_cli_smoke.py
  test_scorer.py
  test_tree_builder.py
```

## Limitations

- No LLM resolver, retry, schema validation, or cache yet.
- No benchmark dataset or precision/recall evaluation harness yet.
- Real-world books with complex layouts may still need rule tuning.
