import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi, afterEach } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildProgram } from "../src/cli.js";
import { runOCRPages } from "../src/core/ocr-extract.js";
import { runAddBookmarks } from "../src/core/pipeline.js";
import { PdfDocument } from "../src/pdf/document.js";
import { CommandOCRBackend } from "../src/ocr/command.js";
import type { OCRBackend, OCRLine } from "../src/types.js";
import { buildHybridPdf, buildScannedLikePdf, buildTextPdf } from "./helpers.js";

const execFileAsync = promisify(execFile);

class StaticOCRBackend implements OCRBackend {
  calls = 0;

  constructor(private readonly lines: OCRLine[]) {}

  extract(options: { pageImageBytes: Uint8Array; lang: string }): OCRLine[] {
    expect(options.pageImageBytes.length).toBeGreaterThan(0);
    expect(options.lang).toBeTruthy();
    this.calls += 1;
    return this.lines;
  }
}

class SequencedOCRBackend implements OCRBackend {
  calls = 0;

  constructor(private readonly pages: OCRLine[][]) {}

  extract(options: { pageImageBytes: Uint8Array; lang: string }): OCRLine[] {
    expect(options.pageImageBytes.length).toBeGreaterThan(0);
    expect(options.lang).toBeTruthy();
    const index = this.calls;
    this.calls += 1;
    return this.pages[index] ?? [];
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pipeline", () => {
  it("adds bookmarks for text PDFs and writes report/toc JSON", async ({ task }) => {
    const dir = fileURLToPath(new URL(`./tmp-${task.id}/`, import.meta.url));
    const inputPdf = join(dir, "book.pdf");
    const outputPdf = join(dir, "book.tagged.pdf");
    const reportPath = join(dir, "report.json");
    const tocPath = join(dir, "toc.json");
    await buildTextPdf(inputPdf);

    const result = await runAddBookmarks({
      inputPath: inputPdf,
      outputPath: outputPdf,
      reportPath,
      tocJsonPath: tocPath,
      lang: "zh",
      enableOcr: false,
      enableLlm: false,
    });

    expect(result.exitCode).toBe(0);
    const tocPayload = JSON.parse(await readFile(tocPath, "utf8"));
    expect(tocPayload.map((node: { title: string }) => node.title)).toEqual([
      "Chapter 1 Introduction",
      "1.1 Background",
      "1.2 Scope",
    ]);
    expect(tocPayload.map((node: { level: number }) => node.level)).toEqual([1, 2, 2]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.doc_type).toBe("text");
    expect(report.accepted_count).toBe(3);
    expect(await outlineTitles(outputPdf)).toEqual(["Chapter 1 Introduction", "1.1 Background", "1.2 Scope"]);
  });

  it("rejects scanned documents when OCR is disabled", async ({ task }) => {
    const dir = fileURLToPath(new URL(`./tmp-${task.id}/`, import.meta.url));
    const inputPdf = join(dir, "scan.pdf");
    const outputPdf = join(dir, "scan.tagged.pdf");
    const reportPath = join(dir, "report.json");
    const tocPath = join(dir, "toc.json");
    await buildScannedLikePdf(inputPdf);

    const result = await runAddBookmarks({
      inputPath: inputPdf,
      outputPath: outputPdf,
      reportPath,
      tocJsonPath: tocPath,
      lang: "zh",
      enableOcr: false,
      enableLlm: false,
    });

    expect(result.exitCode).toBe(2);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(["scanned", "hybrid"]).toContain(report.doc_type);
    expect(report.unsupported_doc_type).toBe(true);
  });

  it("processes scanned documents with OCR backend", async ({ task }) => {
    const dir = fileURLToPath(new URL(`./tmp-${task.id}/`, import.meta.url));
    const inputPdf = join(dir, "scan.pdf");
    const outputPdf = join(dir, "scan.tagged.pdf");
    const reportPath = join(dir, "report.json");
    const tocPath = join(dir, "toc.json");
    await buildScannedLikePdf(inputPdf);
    const ocrBackend = new StaticOCRBackend([
      { text: "Chapter 1 OCR", bbox: [80, 80, 420, 200], confidence: 0.98 },
      { text: "1.1 OCR Background", bbox: [80, 240, 420, 360], confidence: 0.98 },
      { text: "Plain body text", bbox: [80, 300, 420, 322], confidence: 0.98 },
    ]);

    const result = await runAddBookmarks({
      inputPath: inputPdf,
      outputPath: outputPdf,
      reportPath,
      tocJsonPath: tocPath,
      lang: "eng",
      enableOcr: true,
      enableLlm: false,
      ocrBackend,
      ocrStrategy: "full-page",
    });

    expect(result.exitCode).toBe(0);
    expect(ocrBackend.calls).toBe(1);
    const tocPayload = JSON.parse(await readFile(tocPath, "utf8"));
    expect(tocPayload.map((node: { title: string }) => node.title)).toEqual(["Chapter 1 OCR", "1.1 OCR Background"]);
    expect(tocPayload.map((node: { level: number }) => node.level)).toEqual([1, 2]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.doc_type).toBe("scanned");
    expect(report.feature_flags.ocr_executed).toBe(true);
    expect(report.rule_stats.ocr_pages_attempted).toBe(1);
    expect(report.feature_flags.ocr_parallel_mode).toBe("serial");
    expect(report.accepted_count).toBe(2);
  });

  it("routes only sparse hybrid pages through OCR", async ({ task }) => {
    const dir = fileURLToPath(new URL(`./tmp-${task.id}/`, import.meta.url));
    const inputPdf = join(dir, "hybrid.pdf");
    const outputPdf = join(dir, "hybrid.tagged.pdf");
    const reportPath = join(dir, "report.json");
    const tocPath = join(dir, "toc.json");
    await buildHybridPdf(inputPdf);
    const ocrBackend = new StaticOCRBackend([{ text: "1.1 Scanned Section", bbox: [80, 80, 420, 200], confidence: 0.98 }]);

    const result = await runAddBookmarks({
      inputPath: inputPdf,
      outputPath: outputPdf,
      reportPath,
      tocJsonPath: tocPath,
      lang: "eng",
      enableOcr: true,
      enableLlm: false,
      ocrBackend,
      ocrStrategy: "full-page",
    });

    expect(result.exitCode).toBe(0);
    expect(ocrBackend.calls).toBe(1);
    const tocPayload = JSON.parse(await readFile(tocPath, "utf8"));
    expect(tocPayload.map((node: { title: string }) => node.title)).toEqual(["Chapter 1 Text Page", "1.1 Scanned Section"]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.doc_type).toBe("hybrid");
    expect(report.text_pages).toBe(1);
    expect(report.rule_stats.ocr_pages_attempted).toBe(1);
  });

  it("uses toc-guided OCR strategy", async ({ task }) => {
    const dir = fileURLToPath(new URL(`./tmp-${task.id}/`, import.meta.url));
    const inputPdf = join(dir, "scan.pdf");
    const outputPdf = join(dir, "scan.tagged.pdf");
    const reportPath = join(dir, "report.json");
    const tocPath = join(dir, "toc.json");
    await buildScannedLikePdf(inputPdf, 3);
    vi.stubEnv("BUQUE_TOC_GUIDED_TARGET_RENDER_SCALE", "2");
    const ocrBackend = new SequencedOCRBackend([
      [],
      [
        { text: "目录", bbox: [260, 140, 340, 190], confidence: 0.99 },
        { text: "绪论测试", bbox: [180, 320, 340, 350], confidence: 0.99 },
        { text: "1", bbox: [920, 320, 940, 350], confidence: 0.99 },
      ],
      [{ text: "绪论测试", bbox: [220, 180, 380, 230], confidence: 0.99 }],
    ]);

    const result = await runAddBookmarks({
      inputPath: inputPdf,
      outputPath: outputPdf,
      reportPath,
      tocJsonPath: tocPath,
      lang: "zh",
      enableOcr: true,
      enableLlm: false,
      ocrBackend,
    });

    expect(result.exitCode).toBe(0);
    const tocPayload = JSON.parse(await readFile(tocPath, "utf8"));
    expect(tocPayload.map((node: { title: string }) => node.title)).toEqual(["目录", "绪论测试"]);
    expect(tocPayload.map((node: { page_index: number }) => node.page_index)).toEqual([1, 2]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.feature_flags.ocr_strategy).toBe("toc-guided");
    expect(report.feature_flags.toc_guided_executed).toBe(true);
    expect(report.rule_stats.toc_guided_page_offset).toBe(2);
  });

  it("falls back from toc-guided to full-page OCR", async ({ task }) => {
    const dir = fileURLToPath(new URL(`./tmp-${task.id}/`, import.meta.url));
    const inputPdf = join(dir, "scan.pdf");
    const outputPdf = join(dir, "scan.tagged.pdf");
    const reportPath = join(dir, "report.json");
    const tocPath = join(dir, "toc.json");
    await buildScannedLikePdf(inputPdf);
    const ocrBackend = new SequencedOCRBackend([[], [{ text: "Chapter 1 OCR", bbox: [80, 80, 420, 200], confidence: 0.98 }]]);

    const result = await runAddBookmarks({
      inputPath: inputPdf,
      outputPath: outputPdf,
      reportPath,
      tocJsonPath: tocPath,
      lang: "eng",
      enableOcr: true,
      enableLlm: false,
      ocrBackend,
    });

    expect(result.exitCode).toBe(0);
    expect(ocrBackend.calls).toBe(2);
    const tocPayload = JSON.parse(await readFile(tocPath, "utf8"));
    expect(tocPayload.map((node: { title: string }) => node.title)).toEqual(["Chapter 1 OCR"]);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.errors).toContain("toc_guided_fallback_full_page");
  });

  it("parallelizes rebuildable command OCR backend", async ({ task }) => {
    const dir = fileURLToPath(new URL(`./tmp-${task.id}/`, import.meta.url));
    const inputPdf = join(dir, "scan.pdf");
    const scriptPath = join(dir, "ocr-stub.mjs");
    await buildScannedLikePdf(inputPdf, 3);
    await writeFile(scriptPath, "console.log('Chapter 1 OCR');\n", "utf8");
    const backend = new CommandOCRBackend(`${process.execPath} ${scriptPath}`);
    const doc = await PdfDocument.open(inputPdf);
    try {
      const result = await runOCRPages(doc, {
        pageIndexes: [2, 0, 1],
        backend,
        lang: "eng",
        renderScale: 0.5,
        ocrParallelism: 2,
      });
      expect([...result.pageLines.keys()]).toEqual([0, 1, 2]);
      expect(result.stats.ocr_parallelism_requested).toBe(2);
      expect(result.stats.ocr_parallelism_effective).toBe(2);
      expect(result.stats.ocr_parallel_mode).toBe("process");
      expect(result.errors).toEqual([]);
    } finally {
      await doc.destroy();
    }
  });

  it("falls custom backend parallel requests back to serial", async ({ task }) => {
    const dir = fileURLToPath(new URL(`./tmp-${task.id}/`, import.meta.url));
    const inputPdf = join(dir, "scan.pdf");
    await buildScannedLikePdf(inputPdf, 2);
    const backend = new StaticOCRBackend([{ text: "Chapter 1 OCR", bbox: [80, 80, 420, 200], confidence: 0.98 }]);
    const doc = await PdfDocument.open(inputPdf);
    try {
      const result = await runOCRPages(doc, {
        pageIndexes: [0, 1],
        backend,
        lang: "eng",
        renderScale: 0.5,
        ocrParallelism: 2,
      });
      expect(backend.calls).toBe(2);
      expect(result.stats.ocr_parallelism_requested).toBe(2);
      expect(result.stats.ocr_parallelism_effective).toBe(1);
      expect(result.stats.ocr_parallel_mode).toBe("serial");
      expect(result.stats.ocr_parallel_fallback_to_serial).toBe(1);
    } finally {
      await doc.destroy();
    }
  });

  it("uses requested parallelism for full-page fallback", async ({ task }) => {
    const dir = fileURLToPath(new URL(`./tmp-${task.id}/`, import.meta.url));
    const inputPdf = join(dir, "scan.pdf");
    const outputPdf = join(dir, "scan.tagged.pdf");
    const reportPath = join(dir, "report.json");
    const tocPath = join(dir, "toc.json");
    const scriptPath = join(dir, "ocr-stub.mjs");
    await buildScannedLikePdf(inputPdf, 3);
    await writeFile(scriptPath, "console.log('Chapter 1 OCR');\n", "utf8");
    const backend = new CommandOCRBackend(`${process.execPath} ${scriptPath}`);

    const result = await runAddBookmarks({
      inputPath: inputPdf,
      outputPath: outputPdf,
      reportPath,
      tocJsonPath: tocPath,
      lang: "eng",
      enableOcr: true,
      enableLlm: false,
      ocrBackend: backend,
      ocrParallelism: 2,
    });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.errors).toContain("toc_guided_fallback_full_page");
    expect(report.feature_flags.ocr_parallelism_requested).toBe(2);
    expect(report.feature_flags.ocr_parallelism_effective).toBe(2);
    expect(report.feature_flags.ocr_parallel_mode).toBe("process");
  });

  it("rejects invalid CLI OCR parallelism", async ({ task }) => {
    const dir = fileURLToPath(new URL(`./tmp-${task.id}/`, import.meta.url));
    const inputPdf = join(dir, "book.pdf");
    const outputPdf = join(dir, "book.tagged.pdf");
    await buildTextPdf(inputPdf);
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    program.commands.forEach((command) => command.configureOutput({ writeErr: () => undefined, writeOut: () => undefined }));

    await expect(
      program.parseAsync(["add-bookmarks", "--input", inputPdf, "--output", outputPdf, "--ocr-parallelism", "0"], { from: "user" }),
    ).rejects.toThrow();
  });
});

async function outlineTitles(path: string): Promise<string[]> {
  const data = new Uint8Array(await readFile(path));
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true });
  const doc = await loadingTask.promise;
  try {
    const outline = (await doc.getOutline()) ?? [];
    return flattenOutline(outline);
  } finally {
    await loadingTask.destroy();
  }
}

function flattenOutline(items: Array<{ title: string; items?: unknown[] }>): string[] {
  const titles: string[] = [];
  for (const item of items) {
    titles.push(item.title);
    titles.push(...flattenOutline((item.items ?? []) as Array<{ title: string; items?: unknown[] }>));
  }
  return titles;
}
