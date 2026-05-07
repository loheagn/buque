import type { OCRBackend, TocNode } from "../types.js";
import type { PdfDocument } from "../pdf/document.js";
import { expandHeadingFragments, type InternalOCRLine, renderScale, runOCRPages } from "./ocr-extract.js";
import { normalizeTitle } from "./scorer.js";

const TOC_TITLE_RE = /^\s*目\s*录\s*$/u;
const GRAPH_TOC_TITLE_RE = /^\s*图\s*表\s*目\s*录\s*$/u;
const VOLUME_RE = /^第[零一二三四五六七八九十百千万〇\d]+卷/u;
const CHAPTER_RE = /^第[零一二三四五六七八九十百千万〇\d]+章/u;
const STRUCTURAL_RE = /^(绪论|尾声|后记|附录|第[零一二三四五六七八九十百千万〇\d]+[卷章])/u;
const PAGE_NUM_RE = /^\d{1,4}$/u;
const PUNCT_RE = /[\s　!！?？:：,，.。;；、·《》“”"'()（）[\]【】\-—_．…]+/gu;
const RUNNING_HEADERS = new Set(["目录", "世界文字发展史"]);
const FRONT_TITLES = new Set(["作者简介", "目录", "图表目录", "序言", "第二版序言", "第三版序言"]);

export interface TocGuidedResult {
  tocNodes: TocNode[];
  stats: Record<string, unknown>;
  errors: Array<Record<string, unknown>>;
}

interface TocEntry {
  title: string;
  level: number;
  printedPage: number | undefined;
  sourcePageIndex: number;
  y: number;
  confidence: number;
}

interface Match {
  similarity: number;
  title: string;
  pageIndex: number;
}

class OCRPageCache {
  readonly errors: Array<Record<string, unknown>> = [];
  readonly uniquePages = new Set<number>();
  calls = 0;
  pagesWithText = 0;
  lineCount = 0;
  parallelismEffective = 1;
  parallelMode = "serial";
  parallelFallbackToSerial = false;
  private readonly cache = new Map<string, InternalOCRLine[]>();

  constructor(
    private readonly doc: PdfDocument,
    private readonly backend: OCRBackend,
    private readonly lang: string,
    readonly ocrParallelism: number,
  ) {}

  async get(pageIndex: number, options: { renderScale: number }): Promise<InternalOCRLine[]> {
    if (pageIndex < 0 || pageIndex >= this.doc.pageCount) return [];
    const key = cacheKey(pageIndex, options.renderScale);
    if (!this.cache.has(key)) await this.loadPages([pageIndex], { renderScale: options.renderScale, ocrParallelism: 1 });
    return this.cache.get(key) ?? [];
  }

  async prefetch(pageIndexes: Iterable<number>, options: { renderScale: number }): Promise<void> {
    await this.loadPages(pageIndexes, { renderScale: options.renderScale, ocrParallelism: this.ocrParallelism });
  }

  private async loadPages(
    pageIndexes: Iterable<number>,
    options: { renderScale: number; ocrParallelism: number },
  ): Promise<void> {
    const seen = new Set<number>();
    const indexes: number[] = [];
    for (const pageIndex of pageIndexes) {
      if (pageIndex < 0 || pageIndex >= this.doc.pageCount || seen.has(pageIndex)) continue;
      seen.add(pageIndex);
      if (!this.cache.has(cacheKey(pageIndex, options.renderScale))) indexes.push(pageIndex);
    }
    if (indexes.length === 0) return;
    const pageRun = await runOCRPages(this.doc, {
      pageIndexes: indexes,
      backend: this.backend,
      lang: this.lang,
      renderScale: options.renderScale,
      ocrParallelism: options.ocrParallelism,
    });
    for (const pageIndex of indexes) {
      this.cache.set(cacheKey(pageIndex, options.renderScale), pageRun.pageLines.get(pageIndex) ?? []);
    }
    this.errors.push(...pageRun.errors);
    this.calls += Number(pageRun.stats.ocr_pages_attempted ?? 0);
    this.pagesWithText += Number(pageRun.stats.ocr_pages_with_text ?? 0);
    this.lineCount += Number(pageRun.stats.ocr_line_count ?? 0);
    indexes.forEach((pageIndex) => this.uniquePages.add(pageIndex));
    this.parallelismEffective = Math.max(this.parallelismEffective, Number(pageRun.stats.ocr_parallelism_effective ?? 1));
    if (pageRun.stats.ocr_parallel_mode === "process") this.parallelMode = "process";
    if (Number(pageRun.stats.ocr_parallel_fallback_to_serial ?? 0) > 0) this.parallelFallbackToSerial = true;
  }
}

export async function extractTocGuidedNodes(
  doc: PdfDocument,
  options: { backend: OCRBackend; lang: string; ocrParallelism?: number },
): Promise<TocGuidedResult> {
  const tocScale = envFloat("BUQUE_TOC_GUIDED_TOC_RENDER_SCALE", 2.0);
  const targetScale = envFloat("BUQUE_TOC_GUIDED_TARGET_RENDER_SCALE", renderScale());
  const maxFrontScan = envInt("BUQUE_TOC_GUIDED_MAX_FRONT_SCAN", 60);
  const offsetProbePages = envInt("BUQUE_TOC_GUIDED_OFFSET_PROBE_PAGES", 80);
  const confirmWindow = envInt("BUQUE_TOC_GUIDED_CONFIRM_WINDOW", 0);
  const tailScanPages = envInt("BUQUE_TOC_GUIDED_TAIL_SCAN_PAGES", 8);

  const cache = new OCRPageCache(doc, options.backend, options.lang, Math.max(1, options.ocrParallelism ?? 1));
  let tocStart: number | undefined;
  let tocContentEnd: number | undefined;
  let tocScanEnd: number | undefined;
  const parsedRows: TocEntry[] = [];
  const frontNodes: TocNode[] = [];

  const scanLimit = Math.min(doc.pageCount, maxFrontScan);
  for (let pageIndex = 0; pageIndex < scanLimit; pageIndex += 1) {
    const lines = await cache.get(pageIndex, { renderScale: tocScale });
    const pageSize = await doc.getPageSize(pageIndex);
    frontNodes.push(...frontNodesFromPage(lines, pageIndex));

    if (tocStart === undefined) {
      if (hasMainTocTitle(lines)) tocStart = pageIndex;
      else continue;
    }

    if (hasGraphTocTitle(lines) && pageIndex > tocStart) {
      tocContentEnd = pageIndex - 1;
      tocScanEnd = pageIndex;
      break;
    }

    const pageEntries = parseTocPage(lines, { pageIndex, pageWidth: pageSize.width });
    if (pageEntries.length > 0) {
      parsedRows.push(...pageEntries);
      tocContentEnd = pageIndex;
      tocScanEnd = pageIndex;
      continue;
    }

    if (tocContentEnd !== undefined && pageIndex > tocContentEnd) {
      tocScanEnd = pageIndex - 1;
      break;
    }
  }

  const errors: Array<Record<string, unknown>> = [];
  if (tocStart === undefined || tocContentEnd === undefined) {
    errors.push({ reason: "toc_guided_toc_not_found" });
    return result([], cache, [...cache.errors, ...errors], {});
  }

  const structuralEntries = assignMissingPrintedPages(selectStructuralEntries(parsedRows));
  if (structuralEntries.length === 0) {
    errors.push({ reason: "toc_guided_no_structural_entries" });
    return result([], cache, [...cache.errors, ...errors], { toc_guided_toc_pages: tocContentEnd - tocStart + 1 });
  }

  const [firstContentIndex, inferredOffset] = await inferPageOffset({
    doc,
    cache,
    entries: structuralEntries,
    startPage: (tocScanEnd ?? tocContentEnd) + 1,
    maxPages: offsetProbePages,
    renderScale: targetScale,
  });
  let offset = inferredOffset;
  if (offset === undefined) {
    const firstPrinted = structuralEntries.find((entry) => entry.printedPage !== undefined)?.printedPage ?? 1;
    offset = (tocScanEnd ?? tocContentEnd) + 1 - firstPrinted;
    errors.push({ reason: "toc_guided_offset_inferred_weakly", offset });
  }

  const prefaceEnd = firstContentIndex ?? Math.min(doc.pageCount, (tocScanEnd ?? tocContentEnd) + 1 + offsetProbePages);
  const prefaceStart = (tocScanEnd ?? tocContentEnd) + 1;
  const prefaceStop = Math.min(prefaceEnd, doc.pageCount);
  await cache.prefetch(range(prefaceStart, prefaceStop), { renderScale: targetScale });
  for (let pageIndex = prefaceStart; pageIndex < prefaceStop; pageIndex += 1) {
    const lines = await cache.get(pageIndex, { renderScale: targetScale });
    frontNodes.push(...frontNodesFromPage(lines, pageIndex));
  }

  const mainNodes = await entriesToNodes({
    doc,
    cache,
    entries: structuralEntries,
    offset,
    renderScale: targetScale,
    confirmWindow,
  });

  const tailNodes: TocNode[] = [];
  if (mainNodes.length > 0) {
    const tailStart = mainNodes.at(-1)!.pageIndex;
    const tailStop = Math.min(doc.pageCount, tailStart + tailScanPages + 1);
    await cache.prefetch(range(tailStart, tailStop), { renderScale: targetScale });
    for (let pageIndex = tailStart; pageIndex < tailStop; pageIndex += 1) {
      const lines = await cache.get(pageIndex, { renderScale: targetScale });
      const pageSize = await doc.getPageSize(pageIndex);
      tailNodes.push(...tailNodesFromPage(lines, pageIndex, pageSize));
    }
  }

  const tocNodes = dedupeNodes([...frontNodes, ...mainNodes, ...tailNodes]);
  return result(tocNodes, cache, [...cache.errors, ...errors], {
    toc_guided_toc_start_page: tocStart + 1,
    toc_guided_toc_pages: tocContentEnd - tocStart + 1,
    toc_guided_parsed_rows: parsedRows.length,
    toc_guided_structural_entries: structuralEntries.length,
    toc_guided_page_offset: offset,
  });
}

function parseTocPage(lines: InternalOCRLine[], options: { pageIndex: number; pageWidth: number }): TocEntry[] {
  const rows = [
    ...numberedTocRows(lines, options.pageIndex, options.pageWidth),
    ...volumeRowsWithoutPageNumbers(lines, options.pageIndex, options.pageWidth),
  ];
  return rows.sort((left, right) => left.sourcePageIndex - right.sourcePageIndex || left.y - right.y || Number(left.printedPage === undefined) - Number(right.printedPage === undefined) || (left.printedPage ?? 0) - (right.printedPage ?? 0));
}

function numberedTocRows(lines: InternalOCRLine[], pageIndex: number, pageWidth: number): TocEntry[] {
  const rows: TocEntry[] = [];
  for (const numberLine of lines) {
    const pageNumber = pageNumberFromLine(numberLine, pageWidth);
    if (pageNumber === undefined) continue;
    const parts = lines.filter(
      (line) =>
        line !== numberLine &&
        !isRightPageNumber(line, pageWidth) &&
        line.bbox[2] < numberLine.bbox[0] - 4 &&
        sameRow(line, numberLine) &&
        !isRunningHeader(line.text),
    );
    const title = cleanTitle(joinLineParts(parts));
    if (!title) continue;
    rows.push({
      title,
      level: entryLevel(title),
      printedPage: pageNumber,
      sourcePageIndex: pageIndex,
      y: numberLine.bbox[1],
      confidence: avgConfidence([numberLine, ...parts]),
    });
  }
  return rows;
}

function volumeRowsWithoutPageNumbers(lines: InternalOCRLine[], pageIndex: number, pageWidth: number): TocEntry[] {
  const rows: TocEntry[] = [];
  const source = lines.filter(
    (line) =>
      !isRightPageNumber(line, pageWidth) &&
      !isRunningHeader(line.text) &&
      xCenter(line) / Math.max(pageWidth, 1.0) >= 0.18 &&
      xCenter(line) / Math.max(pageWidth, 1.0) <= 0.82,
  );
  for (const cluster of sameRowClusters(source)) {
    const title = cleanTitle(joinLineParts(cluster));
    if (!title || !VOLUME_RE.test(compact(title))) continue;
    rows.push({ title, level: 1, printedPage: undefined, sourcePageIndex: pageIndex, y: Math.min(...cluster.map((line) => line.bbox[1])), confidence: avgConfidence(cluster) });
  }
  return rows;
}

function selectStructuralEntries(entries: TocEntry[]): TocEntry[] {
  const selected: TocEntry[] = [];
  const seen = new Set<string>();
  for (const entry of [...entries].sort((left, right) => left.sourcePageIndex - right.sourcePageIndex || left.y - right.y || Number(left.printedPage === undefined) - Number(right.printedPage === undefined) || (left.printedPage ?? 0) - (right.printedPage ?? 0))) {
    const title = cleanTitle(entry.title);
    const compacted = compact(title);
    if (!STRUCTURAL_RE.test(compacted)) continue;
    const key = structuralKey(compacted);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ title, level: entryLevel(title), printedPage: entry.printedPage, sourcePageIndex: entry.sourcePageIndex, y: entry.y, confidence: entry.confidence });
  }
  return selected;
}

function assignMissingPrintedPages(entries: TocEntry[]): TocEntry[] {
  return entries.map((entry, index) => {
    if (entry.printedPage !== undefined) return entry;
    const nextPrinted = entries.slice(index + 1).find((item) => item.printedPage !== undefined)?.printedPage;
    const previousPrinted = [...entries.slice(0, index)].reverse().find((item) => item.printedPage !== undefined)?.printedPage;
    let printedPage: number | undefined;
    if (nextPrinted !== undefined && VOLUME_RE.test(compact(entry.title))) printedPage = Math.max(1, nextPrinted - 2);
    else if (previousPrinted !== undefined) printedPage = previousPrinted;
    return { ...entry, printedPage };
  });
}

async function inferPageOffset(options: {
  doc: PdfDocument;
  cache: OCRPageCache;
  entries: TocEntry[];
  startPage: number;
  maxPages: number;
  renderScale: number;
}): Promise<[number | undefined, number | undefined]> {
  const anchors = options.entries.filter((entry) => entry.printedPage !== undefined && isAnchorEntry(entry.title)).slice(0, 6);
  if (anchors.length === 0) return [undefined, undefined];
  let best: [number, number, number] | undefined;
  const stopPage = Math.min(options.doc.pageCount, Math.max(options.startPage, 0) + options.maxPages);
  for (let pageIndex = Math.max(0, options.startPage); pageIndex < stopPage; pageIndex += 1) {
    const lines = await options.cache.get(pageIndex, { renderScale: options.renderScale });
    const pageSize = await options.doc.getPageSize(pageIndex);
    for (const entry of anchors) {
      const match = bestPageMatch(lines, entry.title, pageSize, pageIndex);
      if (match.similarity < 0.62) continue;
      const offset = pageIndex + 1 - Number(entry.printedPage);
      const score = match.similarity - 0.01 * anchors.indexOf(entry);
      if (!best || score > best[0]) best = [score, pageIndex, offset];
    }
    if (best && best[0] >= 0.86) break;
  }
  return best ? [best[1], best[2]] : [undefined, undefined];
}

async function entriesToNodes(options: {
  doc: PdfDocument;
  cache: OCRPageCache;
  entries: TocEntry[];
  offset: number;
  renderScale: number;
  confirmWindow: number;
}): Promise<TocNode[]> {
  const entryIndexes: Array<[TocEntry, number[]]> = [];
  const allCandidateIndexes: number[] = [];
  for (const entry of options.entries) {
    if (entry.printedPage === undefined) continue;
    const predictedIndex = entry.printedPage + options.offset - 1;
    const candidateIndexes = range(predictedIndex - options.confirmWindow, predictedIndex + options.confirmWindow + 1).filter(
      (pageIndex) => pageIndex >= 0 && pageIndex < options.doc.pageCount,
    );
    entryIndexes.push([entry, candidateIndexes]);
    allCandidateIndexes.push(...candidateIndexes);
  }
  await options.cache.prefetch(allCandidateIndexes, { renderScale: options.renderScale });

  const nodes: TocNode[] = [];
  for (const [entry, candidateIndexes] of entryIndexes) {
    const predictedIndex = Number(entry.printedPage ?? 1) + options.offset - 1;
    let bestMatch: Match = { similarity: 0.0, title: "", pageIndex: Math.max(0, Math.min(options.doc.pageCount - 1, predictedIndex)) };
    let bestScore = -1.0;
    for (const pageIndex of candidateIndexes) {
      const lines = await options.cache.get(pageIndex, { renderScale: options.renderScale });
      const pageSize = await options.doc.getPageSize(pageIndex);
      const match = bestPageMatch(lines, entry.title, pageSize, pageIndex);
      const score = match.similarity - 0.02 * Math.abs(pageIndex - predictedIndex);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = match;
      }
    }
    nodes.push({
      title: preferConfirmedTitle(entry.title, bestMatch.title),
      level: entry.level,
      pageIndex: bestMatch.pageIndex,
      confidence: Math.max(0.5, Math.min(0.95, 0.6 + 0.35 * bestMatch.similarity)),
      source: "rule",
    });
  }
  return nodes;
}

function frontNodesFromPage(lines: InternalOCRLine[], pageIndex: number): TocNode[] {
  const nodes: TocNode[] = [];
  for (const line of lines.slice(0, 12)) {
    const compacted = compact(line.text);
    if (compacted === "目录" && line.bbox[1] < 60.0) continue;
    if (FRONT_TITLES.has(compacted)) {
      nodes.push({ title: displayTitle(line.text), level: 1, pageIndex, confidence: 0.9, source: "rule" });
    }
  }
  return nodes;
}

function tailNodesFromPage(lines: InternalOCRLine[], pageIndex: number, pageSize: { width: number; height: number }): TocNode[] {
  return pageTitleCandidates(lines, pageSize)
    .filter((title) => {
      const compacted = compact(title);
      return compacted === "后记" || compacted.startsWith("附录") || compacted.endsWith("目录");
    })
    .map((title) => ({ title: displayTitle(title), level: 1, pageIndex, confidence: 0.82, source: "rule" as const }));
}

function bestPageMatch(lines: InternalOCRLine[], title: string, pageSize: { width: number; height: number }, pageIndex: number): Match {
  let best: Match = { similarity: 0.0, title: "", pageIndex };
  for (const candidate of pageTitleCandidates(lines, pageSize)) {
    const similarity = titleSimilarity(title, candidate);
    if (similarity > best.similarity) best = { similarity, title: candidate, pageIndex };
  }
  return best;
}

function pageTitleCandidates(lines: InternalOCRLine[], pageSize: { width: number; height: number }): string[] {
  const topLines = lines.filter(
    (line) =>
      line.bbox[1] / Math.max(pageSize.height, 1.0) <= 0.42 &&
      !isNoiseText(line.text) &&
      xCenter(line) / Math.max(pageSize.width, 1.0) >= 0.08 &&
      xCenter(line) / Math.max(pageSize.width, 1.0) <= 0.92,
  );
  const candidates: string[] = [];
  candidates.push(...expandHeadingFragments(topLines).map((line) => cleanTitle(line.text)));
  candidates.push(...sameRowClusters(topLines).map((cluster) => cleanTitle(joinLineParts(cluster))));
  topLines.forEach((line, index) => {
    if (index + 1 >= topLines.length) return;
    if (!STRUCTURAL_RE.test(compact(line.text))) return;
    const second = topLines[index + 1];
    if (second.bbox[1] - line.bbox[3] > Math.max(44.0, line.height * 2.2)) return;
    candidates.push(cleanTitle(joinLineParts([line, second])));
  });
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || isNoiseText(candidate)) continue;
    const compacted = compact(candidate);
    if (seen.has(compacted)) continue;
    seen.add(compacted);
    result.push(candidate);
  }
  return result;
}

function dedupeNodes(nodes: TocNode[]): TocNode[] {
  const result: TocNode[] = [];
  for (const node of [...nodes].sort((left, right) => left.pageIndex - right.pageIndex || left.level - right.level || left.title.localeCompare(right.title))) {
    let replacementIndex: number | undefined;
    let duplicate = false;
    for (const [index, existing] of result.entries()) {
      if (Math.abs(existing.pageIndex - node.pageIndex) > 0) continue;
      const similarity = titleSimilarity(existing.title, node.title);
      if (similarity >= 0.74 || compact(existing.title).includes(compact(node.title)) || compact(node.title).includes(compact(existing.title))) {
        duplicate = true;
        if (compact(node.title).length > compact(existing.title).length) replacementIndex = index;
        break;
      }
    }
    if (replacementIndex !== undefined) result[replacementIndex] = node;
    else if (!duplicate) result.push(node);
  }
  return result;
}

function result(
  tocNodes: TocNode[],
  cache: OCRPageCache,
  errors: Array<Record<string, unknown>>,
  extraStats: Record<string, number>,
): TocGuidedResult {
  return {
    tocNodes,
    stats: {
      ocr_pages_attempted: cache.calls,
      ocr_unique_pages_attempted: cache.uniquePages.size,
      ocr_pages_with_text: cache.pagesWithText,
      ocr_line_count: cache.lineCount,
      ocr_parallelism_requested: cache.ocrParallelism,
      ocr_parallelism_effective: cache.parallelismEffective,
      ocr_parallel_mode: cache.parallelMode,
      ocr_parallel_fallback_to_serial: Number(cache.parallelFallbackToSerial),
      ocr_candidate_count: tocNodes.length,
      toc_guided_node_count: tocNodes.length,
      ...extraStats,
    },
    errors,
  };
}

function hasMainTocTitle(lines: InternalOCRLine[]): boolean {
  return lines.slice(0, 8).some((line) => TOC_TITLE_RE.test(compact(line.text)));
}

function hasGraphTocTitle(lines: InternalOCRLine[]): boolean {
  return lines.slice(0, 8).some((line) => GRAPH_TOC_TITLE_RE.test(compact(line.text)));
}

function pageNumberFromLine(line: InternalOCRLine, pageWidth: number): number | undefined {
  if (!isRightPageNumber(line, pageWidth)) return undefined;
  return Number(compact(line.text));
}

function isRightPageNumber(line: InternalOCRLine, pageWidth: number): boolean {
  return PAGE_NUM_RE.test(compact(line.text)) && line.bbox[0] / Math.max(pageWidth, 1.0) >= 0.72;
}

function sameRow(line: InternalOCRLine, other: InternalOCRLine): boolean {
  return Math.abs(yCenter(line) - yCenter(other)) <= Math.max(8.0, Math.min(line.height, other.height) * 0.9);
}

function sameRowClusters(lines: Iterable<InternalOCRLine>): InternalOCRLine[][] {
  const clusters: InternalOCRLine[][] = [];
  for (const line of [...lines].sort((left, right) => yCenter(left) - yCenter(right) || left.bbox[0] - right.bbox[0])) {
    const cluster = clusters.find((candidate) => Math.abs(yCenter(candidate[0]) - yCenter(line)) <= Math.max(8.0, line.height));
    if (cluster) cluster.push(line);
    else clusters.push([line]);
  }
  clusters.forEach((cluster) => cluster.sort((left, right) => left.bbox[0] - right.bbox[0]));
  return clusters;
}

function joinLineParts(lines: Iterable<InternalOCRLine>): string {
  const parts = [...lines]
    .sort((left, right) => left.bbox[0] - right.bbox[0])
    .map((line) => normalizeTitle(line.text))
    .filter(Boolean);
  return normalizeTitle(parts.join(""));
}

function cleanTitle(title: string): string {
  let value = normalizeTitle(title).replaceAll("：", ":");
  value = value.replace(/^[一二三四五六七八九十]+(?=第?[^\d])/u, "");
  return normalizeTitle(value);
}

function displayTitle(title: string): string {
  let value = normalizeTitle(title).replaceAll(":", "：");
  if (containsCjk(value)) value = value.replace(/\s+/gu, "");
  return value;
}

function preferConfirmedTitle(entryTitle: string, confirmedTitle: string): string {
  if (!confirmedTitle) return displayTitle(entryTitle);
  const entryCompact = compact(entryTitle);
  const confirmedCompact = compact(confirmedTitle);
  if (entryCompact === "附录" || entryCompact === "后记") {
    if (confirmedCompact.startsWith(entryCompact)) return displayTitle(confirmedTitle);
  }
  if (VOLUME_RE.test(entryCompact) && confirmedCompact.startsWith(entryCompact) && confirmedCompact.length > entryCompact.length) {
    return displayTitle(confirmedTitle);
  }
  return displayTitle(entryTitle);
}

function entryLevel(title: string): number {
  return CHAPTER_RE.test(compact(title)) ? 2 : 1;
}

function isAnchorEntry(title: string): boolean {
  const compacted = compact(title);
  return compacted.startsWith("绪论") || VOLUME_RE.test(compacted) || CHAPTER_RE.test(compacted);
}

function structuralKey(title: string): string {
  const volume = VOLUME_RE.exec(title);
  if (volume) return volume[0];
  const chapter = CHAPTER_RE.exec(title);
  if (chapter) return chapter[0];
  if (title.startsWith("绪论")) return "绪论";
  if (title.startsWith("尾声")) return "尾声";
  if (title.startsWith("后记")) return "后记";
  if (title.startsWith("附录")) return "附录";
  return title;
}

function titleSimilarity(left: string, right: string): number {
  const leftNorm = matchKey(left);
  const rightNorm = matchKey(right);
  if (!leftNorm || !rightNorm) return 0.0;
  if ((leftNorm === "附录" || leftNorm === "后记") && rightNorm.startsWith(leftNorm)) return 0.9;
  if (leftNorm.includes(rightNorm) || rightNorm.includes(leftNorm)) {
    return Math.min(leftNorm.length, rightNorm.length) / Math.max(leftNorm.length, rightNorm.length);
  }
  return sequenceRatio(leftNorm, rightNorm);
}

function sequenceRatio(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return (2 * dp[a.length][b.length]) / Math.max(1, a.length + b.length);
}

function matchKey(value: string): string {
  return value.toLowerCase().replace(PUNCT_RE, "");
}

function compact(value: string): string {
  return normalizeTitle(value).replace(/\s+/gu, "");
}

function isRunningHeader(text: string): boolean {
  return RUNNING_HEADERS.has(compact(text));
}

function isNoiseText(text: string): boolean {
  const compacted = compact(text);
  if (!compacted || /^\d+$/u.test(compacted) || RUNNING_HEADERS.has(compacted)) return true;
  return compacted.length === 1 && "一二三四五六七八九十上下".includes(compacted);
}

function containsCjk(value: string): boolean {
  return [...value].some((char) => char >= "\u4e00" && char <= "\u9fff");
}

function avgConfidence(lines: Iterable<InternalOCRLine>): number {
  const values = [...lines].map((line) => line.confidence).filter((value): value is number => value !== null && value !== undefined);
  return values.length === 0 ? 0.75 : values.reduce((sum, value) => sum + value, 0.0) / values.length;
}

function xCenter(line: InternalOCRLine): number {
  return (line.bbox[0] + line.bbox[2]) / 2.0;
}

function yCenter(line: InternalOCRLine): number {
  return (line.bbox[1] + line.bbox[3]) / 2.0;
}

function cacheKey(pageIndex: number, scale: number): string {
  return `${pageIndex}:${scale}`;
}

function range(start: number, stop: number): number[] {
  return Array.from({ length: Math.max(0, stop - start) }, (_, index) => start + index);
}

function envInt(name: string, defaultValue: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : defaultValue;
}

function envFloat(name: string, defaultValue: number): number {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) ? value : defaultValue;
}
