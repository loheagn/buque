# Buque

For a Chinese version of this document, see [README.zh-CN.md](README.zh-CN.md).

Buque(补阙) is a PDF bookmark generation tool for books. It detects headings in text-based, scanned, and hybrid PDFs and writes them as PDF Outlines, the navigation bookmarks shown by most PDF readers.

Buque does not generate PDF/UA Tagged PDF structure tags. OCR-backed scanned-page routing is implemented. The LLM switch is still reserved for a later stage and does not call an LLM resolver.

## Features

- Detect text-based, scanned, and hybrid PDFs.
- Extract text lines, font size, font name, bold hints, and page coordinates through PDF.js.
- Route scanned or sparse hybrid pages through an OCR command backend when `--enable-ocr` is set.
- Score heading candidates using style, position, numbering pattern, and semantic keyword signals.
- Infer bookmark levels from patterns such as `Chapter 1`, `Section 2`, `Appendix A`, `第1章`, and `1.2.3`.
- Build a deduplicated table of contents with simple level-jump protection.
- Write bookmarks back to a new PDF.
- Emit `toc.json` and `report.json` for inspection.

## Installation

This repository uses Node.js and npm.

```bash
npm install
npm run build
```

Run the CLI from the workspace:

```bash
npx buque --help
```

During development, you can run the TypeScript source directly:

```bash
npx tsx src/cli.ts --help
```

## Usage

```bash
npx buque add-bookmarks \
  --input ./book.pdf \
  --output ./book.bookmarked.pdf \
  --report ./report.json \
  --toc-json ./toc.json
```

The command writes:

- `book.bookmarked.pdf`: output PDF with generated bookmarks.
- `toc.json`: generated bookmark nodes.
- `report.json`: document type, candidate counts, accepted and rejected counts, rule stats, and errors.

## OCR

Scanned and hybrid PDFs require `--enable-ocr` and an OCR command. Set `BUQUE_OCR_COMMAND` to a command that accepts an image path and language and writes one OCR text line per stdout line:

```bash
BUQUE_OCR_COMMAND='my-ocr-command' \
npx buque add-bookmarks --enable-ocr --lang eng \
  --input ./scan.pdf \
  --output ./scan.bookmarked.pdf
```

If the command needs custom argument placement, use `{image}` and `{lang}` placeholders:

```bash
BUQUE_OCR_COMMAND='my-ocr-command --image {image} --lang {lang}'
```

For scanned PDFs that also contain a noisy hidden text layer, set `BUQUE_FORCE_OCR=1` to ignore extracted text and OCR every page. `BUQUE_OCR_RENDER_SCALE` can tune OCR image resolution; higher values are slower but may improve accuracy.

For scanned books, OCR defaults to the `toc-guided` strategy: Buque scans forward to the table of contents, parses its page numbers, and OCRs only the referenced target pages plus small front/tail windows. If the guided path cannot build bookmarks, it automatically falls back to full-page OCR:

```bash
BUQUE_FORCE_OCR=1 \
BUQUE_OCR_RENDER_SCALE=0.5 \
BUQUE_TOC_GUIDED_TOC_RENDER_SCALE=2.0 \
npx buque add-bookmarks --enable-ocr --lang ch \
  --input ./scan.pdf \
  --output ./scan.bookmarked.pdf
```

Pass `--ocr-strategy full-page` to skip the guided path and OCR all routed pages immediately. `BUQUE_TOC_GUIDED_CONFIRM_WINDOW` widens target-page confirmation around each inferred page number when needed; the default is `0`.

OCR is serial by default. Pass `--ocr-parallelism N` with `N > 1` to run multiple OCR command processes concurrently. Custom in-process OCR backends fall back to serial execution.

PaddleOCR is no longer an in-process backend. To use PaddleOCR, wrap it in a command and point `BUQUE_OCR_COMMAND` at that wrapper.

## Development

Run tests:

```bash
npm test
```

Typecheck and build:

```bash
npm run typecheck
npm run build
```

Check production dependency licenses:

```bash
npm run check:licenses
```

## Project Layout

```text
src/
  cli.ts                  # Commander CLI
  core/
    classify.ts           # Text/scanned/hybrid classification
    candidate-rules.ts    # Heading candidate extraction
    ocr-extract.ts        # OCR page rendering and candidate conversion
    pipeline.ts           # End-to-end add-bookmarks flow
    scorer.ts             # Rule scores and level inference
    toc-guided.ts         # TOC-guided scanned-book OCR strategy
    tree-builder.ts       # TOC node construction
    writer.ts             # PDF bookmark writing
  ocr/
    command.ts            # OCR command backend
  pdf/
    document.ts           # PDF.js document adapter
test/
  pipeline.test.ts
  scorer.test.ts
  tree-builder.test.ts
```

## License Notes

The project source remains MIT licensed. Runtime PDF dependencies are MIT or Apache-2.0 licensed: PDF.js (`pdfjs-dist`), `canvas`, `pdf-lib`, and `@lillallol/outline-pdf`.

MuPDF.js/PyMuPDF are intentionally not used because their open-source distribution is AGPL/commercial dual licensed. The `npm run check:licenses` guard fails if AGPL/GPL/LGPL dependencies appear in the lockfile.

## Limitations

- No LLM resolver, retry, schema validation, or cache yet.
- No benchmark dataset or precision/recall evaluation harness yet.
- PDF.js text extraction can expose font and coordinate details differently from PyMuPDF, so complex book layouts may still need rule tuning.
