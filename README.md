# Buque

For a Chinese version of this document, see [README.zh-CN.md](README.zh-CN.md).

Buque(补阙) is a PDF bookmark generation tool for books. The current release focuses on the M1 scope: detecting headings in text-based PDFs and writing them as PDF Outlines, which are the navigation bookmarks shown in most PDF readers.

Buque does not currently generate PDF/UA Tagged PDF structure tags. OCR, hybrid-document routing, and LLM review interfaces are reserved for later stages but are not implemented yet.

## Features

- Detect text-based PDFs and reject unsupported scanned or hybrid PDFs in M1.
- Extract text lines with font size, font name, bold flag, and page coordinates through PyMuPDF.
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

## Current Scope

M1 supports text-based PDFs only. A PDF is treated as text-based when enough pages contain extractable text. Scanned PDFs and hybrid PDFs are rejected with exit code `2`.

The `--enable-ocr`, `--enable-llm`, and `--lang` options are reserved for later stages. Passing them does not enable OCR or LLM processing in the current version.

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
    candidate_rules.py    # Heading candidate extraction
    scorer.py             # Rule scores and level inference
    tree_builder.py       # TOC node construction
    writer.py             # PDF bookmark writing
  ocr/                    # Placeholder OCR interface
  llm/                    # Placeholder LLM interface
tests/
  test_cli_smoke.py
  test_scorer.py
  test_tree_builder.py
```

## Limitations

- No OCR path yet, so scanned PDFs are unsupported.
- No page-level routing yet, so hybrid PDFs are unsupported.
- No LLM resolver, retry, schema validation, or cache yet.
- No benchmark dataset or precision/recall evaluation harness yet.
- Real-world books with complex layouts may still need rule tuning.
