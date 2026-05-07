import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CandidateHeading, OCRBackend, PipelineResult, TocNode } from "../types.js";
import { PdfDocument } from "../pdf/document.js";
import { resolveOCRBackend, NoopOCRBackend } from "../ocr/command.js";
import { extractCandidates, emptyStats } from "./candidate-rules.js";
import { classifyDocument } from "./classify.js";
import { loadConfig } from "./config.js";
import { extractOCRCandidates, type OCRExtractionResult } from "./ocr-extract.js";
import { extractTocGuidedNodes, type TocGuidedResult } from "./toc-guided.js";
import { buildTocNodes } from "./tree-builder.js";
import { writeBookmarks } from "./writer.js";

export interface RunAddBookmarksOptions {
  inputPath: string;
  outputPath: string;
  reportPath: string;
  tocJsonPath: string;
  lang: string;
  enableOcr: boolean;
  enableLlm: boolean;
  configPath?: string | null;
  ocrBackend?: OCRBackend | null;
  ocrStrategy?: string | null;
  ocrParallelism?: number;
}

export async function runAddBookmarks(options: RunAddBookmarksOptions): Promise<PipelineResult> {
  const resolvedOcrStrategy = resolveOcrStrategy(options.ocrStrategy);
  const resolvedOcrParallelism = resolveOcrParallelism(options.ocrParallelism ?? 1);
  const report = newReport({
    enableOcr: options.enableOcr,
    enableLlm: options.enableLlm,
    ocrStrategy: resolvedOcrStrategy,
    ocrParallelism: resolvedOcrParallelism,
  });

  try {
    const config = await loadConfig(options.configPath);
    const doc = await PdfDocument.open(options.inputPath);
    let tocNodes: TocNode[] = [];
    try {
      const classified = await classifyDocument(doc, {
        textRatioHigh: config.thresholds.textRatioHigh,
        textRatioLow: config.thresholds.textRatioLow,
        minTextCharsPerPage: config.thresholds.minTextCharsPerPage,
      });
      report.doc_type = classified.docType;
      report.page_count = classified.pageCount;
      report.text_page_ratio = classified.textPageRatio;
      report.text_pages = classified.textPages;
      const forceOcr = options.enableOcr && envBool("BUQUE_FORCE_OCR");
      report.feature_flags.force_ocr = forceOcr;

      if (classified.docType !== "text" && !options.enableOcr) {
        report.unsupported_doc_type = true;
        report.errors.push("unsupported_doc_type");
        return finalizeResult({
          success: false,
          exitCode: 2,
          message: `Unsupported document type without OCR: ${classified.docType}.`,
          report,
          tocNodes: [],
          reportPath: options.reportPath,
          tocPath: options.tocJsonPath,
        });
      }

      const backend = resolveOCRBackend(options.ocrBackend);
      if ((forceOcr || classified.docType !== "text") && backend instanceof NoopOCRBackend) {
        report.unsupported_doc_type = true;
        report.errors.push("ocr_backend_unavailable");
        return finalizeResult({
          success: false,
          exitCode: 2,
          message: "OCR was requested, but no OCR backend is configured.",
          report,
          tocNodes: [],
          reportPath: options.reportPath,
          tocPath: options.tocJsonPath,
        });
      }

      const textExtraction = forceOcr
        ? { candidates: [] as CandidateHeading[], ruleStats: emptyStats() }
        : extractCandidates(await doc.extractTextLines(), { rules: config.rules, scoreWeights: config.scoreWeights });
      const candidates = [...textExtraction.candidates];
      let guidedTocNodes: TocNode[] | undefined;
      const ruleStats: Record<string, unknown> = {
        ...textExtraction.ruleStats,
        threshold_high: config.thresholds.high,
        text_candidate_count: textExtraction.candidates.length,
      };

      if (options.enableOcr) {
        const ocrIndexes = ocrPageIndexes({
          docType: classified.docType,
          pageCharCounts: classified.pageCharCounts,
          minTextCharsPerPage: config.thresholds.minTextCharsPerPage,
          forceOcr,
        });
        if (ocrIndexes.length > 0) {
          if (resolvedOcrStrategy === "toc-guided") {
            const guidedResult = await extractTocGuidedNodes(doc, {
              backend,
              lang: options.lang,
              ocrParallelism: resolvedOcrParallelism,
            });
            report.feature_flags.ocr_executed = true;
            report.feature_flags.toc_guided_executed = true;
            Object.assign(ruleStats, guidedResult.stats);
            updateOcrParallelReport(report, guidedResult.stats);
            addTocGuidedErrors(report, guidedResult);
            if (guidedResult.tocNodes.length > 0) {
              guidedTocNodes = guidedResult.tocNodes;
            } else if (!envBool("BUQUE_TOC_GUIDED_DISABLE_FALLBACK")) {
              report.errors.push("toc_guided_fallback_full_page");
              const ocrResult = await extractOCRCandidates(doc, {
                pageIndexes: ocrIndexes,
                backend,
                lang: options.lang,
                rules: config.rules,
                scoreWeights: config.scoreWeights,
                ocrParallelism: resolvedOcrParallelism,
              });
              candidates.push(...ocrResult.candidates);
              Object.assign(ruleStats, ocrResult.stats);
              updateOcrParallelReport(report, ocrResult.stats);
              addOcrErrors(report, ocrResult);
            }
          } else {
            const ocrResult = await extractOCRCandidates(doc, {
              pageIndexes: ocrIndexes,
              backend,
              lang: options.lang,
              rules: config.rules,
              scoreWeights: config.scoreWeights,
              ocrParallelism: resolvedOcrParallelism,
            });
            report.feature_flags.ocr_executed = true;
            candidates.push(...ocrResult.candidates);
            Object.assign(ruleStats, ocrResult.stats);
            updateOcrParallelReport(report, ocrResult.stats);
            addOcrErrors(report, ocrResult);
          }
        }
      }

      report.rule_stats = ruleStats;

      if (guidedTocNodes !== undefined) {
        tocNodes = guidedTocNodes;
        report.candidate_count = tocNodes.length;
        report.accepted_count = tocNodes.length;
        report.rejected_nodes = [];
        report.rejected_count = 0;
      } else {
        report.candidate_count = candidates.length;
        const [accepted, rejectedLow] = splitCandidates(candidates, config.thresholds.high);
        const treeResult = buildTocNodes(accepted, { maxLevelJump: config.thresholds.maxLevelJump });
        tocNodes = addCoverNodeIfNeeded(treeResult.tocNodes, classified.pageCount);
        report.accepted_count = tocNodes.length;
        report.rejected_nodes = [...rejectedLow, ...treeResult.rejectedNodes];
        report.rejected_count = report.rejected_nodes.length;
      }

      if (classified.docType !== "text" && candidates.length === 0 && guidedTocNodes === undefined) {
        report.errors.push("ocr_no_candidates");
        return finalizeResult({
          success: false,
          exitCode: 2,
          message: "OCR completed, but no bookmark candidates were detected.",
          report,
          tocNodes: [],
          reportPath: options.reportPath,
          tocPath: options.tocJsonPath,
        });
      }
    } finally {
      await doc.destroy();
    }

    await writeBookmarks({ inputPath: options.inputPath, outputPath: options.outputPath, tocNodes });
    return finalizeResult({
      success: true,
      exitCode: 0,
      message: `Bookmarks written to ${options.outputPath}`,
      report,
      tocNodes,
      reportPath: options.reportPath,
      tocPath: options.tocJsonPath,
    });
  } catch (error: unknown) {
    const encrypted = isPasswordError(error);
    report.errors.push(encrypted ? "input_encrypted" : "processing_error");
    return finalizeResult({
      success: false,
      exitCode: 3,
      message: encrypted
        ? "Failed to process input PDF: encrypted or password-protected file."
        : `Failed to process input PDF: ${error instanceof Error ? error.message : String(error)}`,
      report,
      tocNodes: [],
      reportPath: options.reportPath,
      tocPath: options.tocJsonPath,
    });
  }
}

function addCoverNodeIfNeeded(tocNodes: TocNode[], pageCount: number): TocNode[] {
  if (pageCount <= 0 || tocNodes.length === 0 || tocNodes[0].pageIndex === 0) return tocNodes;
  if (tocNodes.some((node) => node.pageIndex === 0 || node.title === "封面")) return tocNodes;
  if (!looksLikeLongBookOutline(tocNodes, pageCount)) return tocNodes;
  return [{ title: "封面", level: 1, pageIndex: 0, confidence: 0.6, source: "rule" }, ...tocNodes];
}

function looksLikeLongBookOutline(tocNodes: TocNode[], pageCount: number): boolean {
  if (pageCount < 20 || tocNodes.length < 5) return false;
  const frontMatterCount = tocNodes
    .slice(0, 10)
    .filter((node) => /^(作者简介|目录|图表目录|序言|第[二三四五六七八九十]+版序言)/u.test(node.title)).length;
  const structuralCount = tocNodes.filter((node) => /^(绪论|第[零一二三四五六七八九十百千万〇\d]+[卷章]|尾声|后记|附录)/u.test(node.title)).length;
  return frontMatterCount >= 2 && structuralCount >= 3;
}

function splitCandidates(candidates: CandidateHeading[], highThreshold: number): [CandidateHeading[], Array<Record<string, unknown>>] {
  const accepted: CandidateHeading[] = [];
  const rejected: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    if (isHighConfidence(candidate, highThreshold)) {
      accepted.push(candidate);
    } else {
      rejected.push({
        page_index: candidate.pageIndex,
        title: candidate.text,
        reason: "below_threshold",
        score: candidate.totalScore,
      });
    }
  }
  return [accepted, rejected];
}

function isHighConfidence(candidate: CandidateHeading, highThreshold: number): boolean {
  if (candidate.source === "ocr") {
    if (candidate.semanticScore >= 0.6 && candidate.positionScore >= 0.6 && candidate.totalScore >= 0.5) return true;
    return candidate.totalScore >= Math.max(highThreshold, 0.85);
  }
  if (candidate.semanticScore >= 0.6 && candidate.positionScore >= 0.6 && candidate.styleScore >= 0.45) return true;
  if (candidate.totalScore >= highThreshold) return true;
  return candidate.patternScore >= 1.0 && candidate.styleScore >= 0.5;
}

function ocrPageIndexes(options: {
  docType: string;
  pageCharCounts: number[];
  minTextCharsPerPage: number;
  forceOcr: boolean;
}): number[] {
  if (options.forceOcr) return options.pageCharCounts.map((_value, index) => index);
  if (options.docType === "text") return [];
  if (options.docType === "scanned") return options.pageCharCounts.map((_value, index) => index);
  return options.pageCharCounts.flatMap((charCount, pageIndex) => (charCount < options.minTextCharsPerPage ? [pageIndex] : []));
}

function addOcrErrors(report: ReportShape, ocrResult: OCRExtractionResult): void {
  if (ocrResult.errors.length === 0) return;
  report.ocr_errors = ocrResult.errors;
  if (!report.errors.includes("ocr_backend_error")) report.errors.push("ocr_backend_error");
}

function addTocGuidedErrors(report: ReportShape, guidedResult: TocGuidedResult): void {
  if (guidedResult.errors.length === 0) return;
  report.toc_guided_errors = guidedResult.errors;
  if (guidedResult.errors.some((error) => error.reason === "ocr_backend_error") && !report.errors.includes("ocr_backend_error")) {
    report.errors.push("ocr_backend_error");
  }
}

function resolveOcrStrategy(value?: string | null): string {
  const rawValue = (value || process.env.BUQUE_OCR_STRATEGY || "toc-guided").trim().toLowerCase();
  const normalized = rawValue.replaceAll("_", "-");
  return normalized === "full-page" || normalized === "toc-guided" ? normalized : "toc-guided";
}

function resolveOcrParallelism(value: number): number {
  const resolved = Math.trunc(Number(value));
  return Number.isFinite(resolved) ? Math.max(1, resolved) : 1;
}

function updateOcrParallelReport(report: ReportShape, stats: Record<string, unknown>): void {
  if (stats.ocr_parallelism_requested !== undefined) report.feature_flags.ocr_parallelism_requested = Math.trunc(Number(stats.ocr_parallelism_requested));
  if (stats.ocr_parallelism_effective !== undefined) report.feature_flags.ocr_parallelism_effective = Math.trunc(Number(stats.ocr_parallelism_effective));
  if (stats.ocr_parallel_mode !== undefined) report.feature_flags.ocr_parallel_mode = String(stats.ocr_parallel_mode);
}

interface ReportShape {
  doc_type: string | null;
  page_count: number;
  candidate_count: number;
  accepted_count: number;
  rejected_count: number;
  rule_stats: Record<string, unknown>;
  errors: string[];
  llm_degraded: boolean;
  unsupported_doc_type: boolean;
  feature_flags: Record<string, unknown>;
  rejected_nodes: Array<Record<string, unknown>>;
  text_page_ratio?: number;
  text_pages?: number;
  ocr_errors?: Array<Record<string, unknown>>;
  toc_guided_errors?: Array<Record<string, unknown>>;
}

function newReport(options: { enableOcr: boolean; enableLlm: boolean; ocrStrategy: string; ocrParallelism: number }): ReportShape {
  return {
    doc_type: null,
    page_count: 0,
    candidate_count: 0,
    accepted_count: 0,
    rejected_count: 0,
    rule_stats: {},
    errors: [],
    llm_degraded: Boolean(options.enableLlm),
    unsupported_doc_type: false,
    feature_flags: {
      enable_ocr: options.enableOcr,
      enable_llm: options.enableLlm,
      ocr_executed: false,
      ocr_strategy: options.ocrStrategy,
      ocr_parallelism_requested: options.ocrParallelism,
      ocr_parallelism_effective: 1,
      ocr_parallel_mode: "serial",
      toc_guided_executed: false,
      llm_executed: false,
    },
    rejected_nodes: [],
  };
}

async function finalizeResult(options: {
  success: boolean;
  exitCode: number;
  message: string;
  report: ReportShape;
  tocNodes: TocNode[];
  reportPath: string;
  tocPath: string;
}): Promise<PipelineResult> {
  await writeJson(options.tocPath, options.tocNodes.map(tocNodeToJson));
  await writeJson(options.reportPath, options.report);
  return {
    success: options.success,
    exitCode: options.exitCode,
    message: options.message,
    report: options.report as unknown as Record<string, unknown>,
    tocNodes: options.tocNodes,
  };
}

function tocNodeToJson(node: TocNode): Record<string, unknown> {
  return {
    title: node.title,
    level: node.level,
    page_index: node.pageIndex,
    confidence: node.confidence,
    source: node.source,
  };
}

async function writeJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(sortJson(payload), null, 2)}\n`, "utf8");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sortJson(item)]));
}

function envBool(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(process.env[name]?.trim().toLowerCase() ?? "");
}

function isPasswordError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /password|encrypted/i.test(`${error.name} ${error.message}`);
}
