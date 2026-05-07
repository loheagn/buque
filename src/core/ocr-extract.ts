import type { BBox, CandidateHeading, OCRBackend, OCRLine, OCRTextLine, RuleConfig, ScoreWeights } from "../types.js";
import type { PdfDocument } from "../pdf/document.js";
import { isRebuildableCommandBackend } from "../ocr/command.js";
import { clamp, inferNumberedLevel, normalizeTitle, patternScore, positionScore, semanticScore, totalScore } from "./scorer.js";

const DEFAULT_RENDER_SCALE = 2.0;
const CHINESE_VOLUME_TITLE_RE = /^\s*第[零一二三四五六七八九十百千万〇\d]+卷/u;
const CHINESE_CHAPTER_TITLE_RE = /^\s*第[零一二三四五六七八九十百千万〇\d]+章/u;
const HEADING_PREFIX_RE = /^\s*(第[零一二三四五六七八九十百千万〇\d]+[卷章节]|附录|绪论[:：]?|尾\s*声)\s*$/u;

export interface OCRExtractionResult {
  candidates: CandidateHeading[];
  stats: Record<string, unknown>;
  errors: Array<Record<string, unknown>>;
}

export interface OCRPageRunResult {
  pageLines: Map<number, InternalOCRLine[]>;
  stats: Record<string, unknown>;
  errors: Array<Record<string, unknown>>;
}

export interface InternalOCRLine {
  text: string;
  bbox: BBox;
  confidence?: number | null;
  height: number;
}

export async function extractOCRCandidates(
  doc: PdfDocument,
  options: {
    pageIndexes: Iterable<number>;
    backend: OCRBackend;
    lang: string;
    rules: RuleConfig;
    scoreWeights: ScoreWeights;
    ocrParallelism?: number;
  },
): Promise<OCRExtractionResult> {
  const pageRun = await runOCRPages(doc, {
    pageIndexes: options.pageIndexes,
    backend: options.backend,
    lang: options.lang,
    renderScale: renderScale(),
    ocrParallelism: options.ocrParallelism ?? 1,
  });
  const allLines = [...pageRun.pageLines.values()].flat();
  const bodyLineHeight = estimateBodyLineHeight(allLines);
  const candidates: CandidateHeading[] = [];
  for (const [pageIndex, normalizedLines] of pageRun.pageLines) {
    const pageSize = await doc.getPageSize(pageIndex);
    candidates.push(
      ...linesToCandidates({
        lines: normalizedLines,
        pageIndex,
        pageHeight: pageSize.height,
        bodyLineHeight,
        rules: options.rules,
        scoreWeights: options.scoreWeights,
      }),
    );
  }
  applyOCRContextualLevels(candidates);
  return {
    candidates,
    stats: { ...pageRun.stats, ocr_candidate_count: candidates.length },
    errors: pageRun.errors,
  };
}

export async function runOCRPages(
  doc: PdfDocument,
  options: {
    pageIndexes: Iterable<number>;
    backend: OCRBackend;
    lang: string;
    renderScale: number;
    ocrParallelism?: number;
  },
): Promise<OCRPageRunResult> {
  const requestedParallelism = normalizeParallelism(options.ocrParallelism ?? 1);
  const indexes = validUniquePageIndexes(options.pageIndexes, doc.pageCount);
  if (requestedParallelism <= 1 || !isRebuildableCommandBackend(options.backend) || indexes.length <= 1) {
    return runOCRPagesSerial(doc, {
      pageIndexes: indexes,
      backend: options.backend,
      lang: options.lang,
      renderScale: options.renderScale,
      requestedParallelism,
      fallbackToSerial: requestedParallelism > 1 && !isRebuildableCommandBackend(options.backend),
    });
  }
  return runOCRPagesConcurrent(doc, {
    pageIndexes: indexes,
    backend: options.backend,
    lang: options.lang,
    renderScale: options.renderScale,
    requestedParallelism,
    effectiveParallelism: Math.min(requestedParallelism, indexes.length),
  });
}

async function runOCRPagesSerial(
  doc: PdfDocument,
  options: {
    pageIndexes: number[];
    backend: OCRBackend;
    lang: string;
    renderScale: number;
    requestedParallelism: number;
    fallbackToSerial?: boolean;
  },
): Promise<OCRPageRunResult> {
  const pageLines = new Map<number, InternalOCRLine[]>();
  const errors: Array<Record<string, unknown>> = [];
  let lineCount = 0;
  let pagesWithText = 0;

  for (const pageIndex of options.pageIndexes) {
    const result = await runSingleOCRPage(doc, options.backend, {
      pageIndex,
      lang: options.lang,
      renderScale: options.renderScale,
    });
    if (result.error) errors.push(result.error);
    if (result.lines.length > 0) pagesWithText += 1;
    lineCount += result.lines.length;
    pageLines.set(pageIndex, result.lines);
  }

  return {
    pageLines: sortPageLineMap(pageLines),
    stats: ocrPageRunStats({
      pagesAttempted: options.pageIndexes.length,
      pagesWithText,
      lineCount,
      requestedParallelism: options.requestedParallelism,
      effectiveParallelism: 1,
      mode: "serial",
      fallbackToSerial: Boolean(options.fallbackToSerial),
    }),
    errors,
  };
}

async function runOCRPagesConcurrent(
  doc: PdfDocument,
  options: {
    pageIndexes: number[];
    backend: OCRBackend;
    lang: string;
    renderScale: number;
    requestedParallelism: number;
    effectiveParallelism: number;
  },
): Promise<OCRPageRunResult> {
  const pageLines = new Map<number, InternalOCRLine[]>();
  const errors: Array<Record<string, unknown>> = [];
  let cursor = 0;
  let lineCount = 0;
  let pagesWithText = 0;

  async function worker(): Promise<void> {
    while (cursor < options.pageIndexes.length) {
      const pageIndex = options.pageIndexes[cursor++];
      const result = await runSingleOCRPage(doc, options.backend, {
        pageIndex,
        lang: options.lang,
        renderScale: options.renderScale,
      });
      if (result.error) errors.push(result.error);
      if (result.lines.length > 0) pagesWithText += 1;
      lineCount += result.lines.length;
      pageLines.set(pageIndex, result.lines);
    }
  }

  await Promise.all(Array.from({ length: options.effectiveParallelism }, () => worker()));

  return {
    pageLines: sortPageLineMap(pageLines),
    stats: ocrPageRunStats({
      pagesAttempted: options.pageIndexes.length,
      pagesWithText,
      lineCount,
      requestedParallelism: options.requestedParallelism,
      effectiveParallelism: options.effectiveParallelism,
      mode: "process",
      fallbackToSerial: false,
    }),
    errors,
  };
}

async function runSingleOCRPage(
  doc: PdfDocument,
  backend: OCRBackend,
  options: { pageIndex: number; lang: string; renderScale: number },
): Promise<{ lines: InternalOCRLine[]; error?: Record<string, unknown> }> {
  if (envBool("BUQUE_OCR_PROGRESS")) {
    process.stdout.write(`OCR page ${options.pageIndex + 1}/${doc.pageCount}\n`);
  }
  try {
    const pageSize = await doc.getPageSize(options.pageIndex);
    const pageImageBytes = await doc.renderPagePng(options.pageIndex, options.renderScale);
    const rawLines = await backend.extract({ pageImageBytes, lang: options.lang });
    return {
      lines: coerceOCRLines(rawLines, {
        pageHeight: pageSize.height,
        renderScale: options.renderScale,
      }),
    };
  } catch (error: unknown) {
    return { lines: [], error: ocrPageError(options.pageIndex, error) };
  }
}

function coerceOCRLines(rawLines: OCRLine[], options: { pageHeight: number; renderScale: number }): InternalOCRLine[] {
  const lines: InternalOCRLine[] = [];
  rawLines.forEach((rawLine, index) => {
    if (isOCRTextLine(rawLine)) {
      const text = normalizeTitle(rawLine.text);
      if (!text) return;
      const bbox = rawLine.bbox ? scaleBBox(rawLine.bbox, options.renderScale) : syntheticBBox(index, options.pageHeight);
      lines.push({ text, bbox, confidence: rawLine.confidence, height: Math.max(0.0, bbox[3] - bbox[1]) });
      return;
    }
    const text = normalizeTitle(String(rawLine));
    if (!text) return;
    const bbox = syntheticBBox(index, options.pageHeight);
    lines.push({ text, bbox, height: Math.max(0.0, bbox[3] - bbox[1]) });
  });
  return lines.sort((left, right) => left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]);
}

export function linesToCandidates(options: {
  lines: InternalOCRLine[];
  pageIndex: number;
  pageHeight: number;
  bodyLineHeight: number;
  rules: RuleConfig;
  scoreWeights: ScoreWeights;
}): CandidateHeading[] {
  const candidates: CandidateHeading[] = [];
  let pageCandidateCount = 0;
  for (const line of expandHeadingFragments(options.lines)) {
    const text = normalizeTitle(line.text);
    if (isNoiseTitle(text)) continue;
    if (text.length < options.rules.minLineChars || text.length > options.rules.maxLineChars) continue;
    const pattern = patternScore(text);
    const semantic = semanticScore(text);
    const topRatioValue = topRatio(line.bbox, options.pageHeight);
    const style = ocrStyleScore({ line, bodyLineHeight: options.bodyLineHeight, pattern, semantic, topRatio: topRatioValue });
    if (!isCandidateFragment({ text, style, pattern, semantic, topRatio: topRatioValue, rules: options.rules })) continue;
    if (pageCandidateCount >= options.rules.maxCandidatesPerPage) break;
    const position = positionScore(topRatioValue);
    const score = totalScore({ weights: options.scoreWeights, style, position, pattern, semantic });
    const levelHint = inferNumberedLevel(text) ?? 1;
    candidates.push({
      pageIndex: options.pageIndex,
      text,
      bbox: line.bbox,
      source: "ocr",
      styleScore: style,
      positionScore: position,
      patternScore: pattern,
      semanticScore: semantic,
      totalScore: score,
      levelHint: Math.max(1, Math.min(6, levelHint)),
    });
    pageCandidateCount += 1;
  }
  return candidates;
}

export function expandHeadingFragments(lines: InternalOCRLine[]): InternalOCRLine[] {
  const fragments: InternalOCRLine[] = [];
  const skipIndexes = new Set<number>();
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = lines[index + 1];
    if (index + 2 < lines.length && shouldCombineHeading(line, nextLine)) {
      const thirdLine = lines[index + 2];
      if (shouldExtendHeading(line, nextLine, thirdLine)) {
        fragments.push(combineLines(combineLines(line, nextLine), thirdLine));
        skipIndexes.add(index);
        skipIndexes.add(index + 1);
        continue;
      }
    }
    if (shouldCombineHeading(line, nextLine)) {
      fragments.push(combineLines(line, nextLine));
      skipIndexes.add(index);
    }
  }
  lines.forEach((line, index) => {
    if (!skipIndexes.has(index)) fragments.push(line);
  });
  return fragments.sort((left, right) => left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0] || left.text.length - right.text.length);
}

export function renderScale(): number {
  const raw = process.env.BUQUE_OCR_RENDER_SCALE?.trim();
  if (!raw) return DEFAULT_RENDER_SCALE;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0.25, Math.min(4.0, value)) : DEFAULT_RENDER_SCALE;
}

function shouldCombineHeading(line: InternalOCRLine, nextLine: InternalOCRLine): boolean {
  const text = compactTitle(line.text);
  const nextText = compactTitle(nextLine.text);
  if (!text || !nextText || nextText.length > 28) return false;
  if (nextLine.bbox[1] - line.bbox[3] > Math.max(36.0, line.height * 1.8)) return false;
  return HEADING_PREFIX_RE.test(text);
}

function shouldExtendHeading(_first: InternalOCRLine, second: InternalOCRLine, third: InternalOCRLine): boolean {
  const thirdText = compactTitle(third.text);
  if (!thirdText || thirdText.length > 24) return false;
  if (third.bbox[1] - second.bbox[3] > Math.max(36.0, second.height * 1.8)) return false;
  const secondText = compactTitle(second.text);
  return secondText.includes("之一") || secondText.includes("之二");
}

function combineLines(first: InternalOCRLine, second: InternalOCRLine): InternalOCRLine {
  const bbox = unionBBox(first.bbox, second.bbox);
  return {
    text: joinTitleParts(first.text, second.text),
    bbox,
    confidence: avgConfidence([first.confidence, second.confidence]),
    height: Math.max(0.0, bbox[3] - bbox[1]),
  };
}

function joinTitleParts(first: string, second: string): string {
  const left = first.trim();
  const right = second.trim();
  return containsCjk(left) || containsCjk(right) ? `${left}${right}` : `${left} ${right}`;
}

function isCandidateFragment(options: {
  text: string;
  style: number;
  pattern: number;
  semantic: number;
  topRatio: number;
  rules: RuleConfig;
}): boolean {
  if (options.pattern >= options.rules.minPatternCandidate) return true;
  if (options.semantic >= options.rules.minSemanticCandidate && options.topRatio <= 0.45 && options.text.length <= 40) return true;
  return options.style >= options.rules.minStyleCandidate && options.topRatio <= 0.35 && options.text.length <= 40;
}

function isNoiseTitle(text: string): boolean {
  const compact = compactTitle(text);
  if (!compact || /^\d+$/u.test(compact)) return true;
  const cjkCount = [...compact].filter((char) => char >= "\u4e00" && char <= "\u9fff").length;
  const alphaCount = [...compact].filter((char) => /\p{L}/u.test(char)).length;
  return compact.length >= 4 && cjkCount === 0 && alphaCount === 0;
}

function ocrStyleScore(options: {
  line: InternalOCRLine;
  bodyLineHeight: number;
  pattern: number;
  semantic: number;
  topRatio: number;
}): number {
  const baseline = options.bodyLineHeight > 0 ? options.bodyLineHeight : Math.max(options.line.height, 1.0);
  const sizeComponent = clamp((options.line.height / baseline - 1.0) / 1.2);
  const prior = ocrStylePrior(options.pattern, options.semantic, options.topRatio);
  const confidenceComponent =
    options.line.confidence === undefined || options.line.confidence === null ? 0.0 : clamp((options.line.confidence - 0.8) / 0.2) * 0.1;
  return clamp(Math.max(prior, sizeComponent) + confidenceComponent);
}

function applyOCRContextualLevels(candidates: CandidateHeading[]): void {
  let seenVolume = false;
  for (const candidate of [...candidates].sort((left, right) => left.pageIndex - right.pageIndex || left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0])) {
    const title = compactTitle(candidate.text);
    if (CHINESE_VOLUME_TITLE_RE.test(title)) {
      seenVolume = true;
      candidate.levelHint = 1;
    } else if (seenVolume && CHINESE_CHAPTER_TITLE_RE.test(title)) {
      candidate.levelHint = Math.max(candidate.levelHint ?? 1, 2);
    }
  }
}

function validUniquePageIndexes(pageIndexes: Iterable<number>, pageCount: number): number[] {
  const seen = new Set<number>();
  const indexes: number[] = [];
  for (const pageIndex of pageIndexes) {
    if (pageIndex < 0 || pageIndex >= pageCount || seen.has(pageIndex)) continue;
    seen.add(pageIndex);
    indexes.push(pageIndex);
  }
  return indexes;
}

function normalizeParallelism(value: number): number {
  return Math.max(1, Math.trunc(Number.isFinite(value) ? value : 1));
}

function ocrPageRunStats(options: {
  pagesAttempted: number;
  pagesWithText: number;
  lineCount: number;
  requestedParallelism: number;
  effectiveParallelism: number;
  mode: string;
  fallbackToSerial: boolean;
}): Record<string, unknown> {
  return {
    ocr_pages_attempted: options.pagesAttempted,
    ocr_pages_with_text: options.pagesWithText,
    ocr_line_count: options.lineCount,
    ocr_parallelism_requested: options.requestedParallelism,
    ocr_parallelism_effective: options.effectiveParallelism,
    ocr_parallel_mode: options.mode,
    ocr_parallel_fallback_to_serial: Number(options.fallbackToSerial),
  };
}

function ocrPageError(pageIndex: number, error: unknown): Record<string, unknown> {
  return { page_index: pageIndex, reason: "ocr_backend_error", detail: error instanceof Error ? error.message : String(error) };
}

function sortPageLineMap(pageLines: Map<number, InternalOCRLine[]>): Map<number, InternalOCRLine[]> {
  return new Map([...pageLines.entries()].sort((left, right) => left[0] - right[0]));
}

function isOCRTextLine(line: OCRLine): line is OCRTextLine {
  return typeof line === "object" && line !== null && "text" in line;
}

function scaleBBox(bbox: BBox, renderScaleValue: number): BBox {
  return bbox.map((value) => value / renderScaleValue) as BBox;
}

function syntheticBBox(lineIndex: number, pageHeight: number): BBox {
  const y = Math.max(0.0, Math.min(pageHeight - 1.0, 72.0 + lineIndex * 18.0));
  return [72.0, y, 540.0, y + 12.0];
}

function topRatio(bbox: BBox, pageHeight: number): number {
  return pageHeight <= 0 ? 1.0 : Math.max(0.0, Math.min(1.0, bbox[1] / pageHeight));
}

function estimateBodyLineHeight(lines: InternalOCRLine[]): number {
  const heights = lines.map((line) => line.height).filter((height) => height >= 6.0 && height <= 32.0).sort((left, right) => left - right);
  if (heights.length === 0) return 12.0;
  const middle = Math.floor(heights.length / 2);
  return heights.length % 2 === 1 ? heights[middle] : (heights[middle - 1] + heights[middle]) / 2.0;
}

function ocrStylePrior(pattern: number, semantic: number, topRatioValue: number): number {
  if (pattern >= 1.0) return 0.6;
  if (semantic >= 0.5 && topRatioValue <= 0.4) return 0.5;
  return 0.0;
}

function compactTitle(value: string): string {
  return value.replace(/\s+/gu, "");
}

function containsCjk(value: string): boolean {
  return [...value].some((char) => char >= "\u4e00" && char <= "\u9fff");
}

function unionBBox(first: BBox, second: BBox): BBox {
  return [Math.min(first[0], second[0]), Math.min(first[1], second[1]), Math.max(first[2], second[2]), Math.max(first[3], second[3])];
}

function avgConfidence(values: Array<number | null | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== null && value !== undefined);
  return present.length === 0 ? undefined : present.reduce((sum, value) => sum + value, 0.0) / present.length;
}

function envBool(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(process.env[name]?.trim().toLowerCase() ?? "");
}
