import type { CandidateHeading, RuleConfig, ScoreWeights, TextLine } from "../types.js";
import {
  inferNumberedLevel,
  normalizeTitle,
  patternScore,
  positionScore,
  semanticScore,
  styleScore,
  totalScore,
} from "./scorer.js";

export interface CandidateExtractionResult {
  candidates: CandidateHeading[];
  ruleStats: Record<string, number>;
}

interface ScoredLine {
  line: TextLine;
  text: string;
  style: number;
  position: number;
  pattern: number;
  semantic: number;
  total: number;
}

export function extractCandidates(
  lines: TextLine[],
  options: { rules: RuleConfig; scoreWeights: ScoreWeights },
): CandidateExtractionResult {
  if (lines.length === 0) return { candidates: [], ruleStats: emptyStats() };

  const expandedLines = expandTextHeadingFragments(lines);
  const bodyFontSize = estimateBodyFontSize(expandedLines);
  const bodyFontName = estimateBodyFontName(expandedLines, bodyFontSize);
  const pageCandidateCounts = new Map<number, number>();
  const scoredLines: ScoredLine[] = [];

  for (const line of expandedLines) {
    const text = normalizeCandidateTitle(line.text);
    if (text.length < options.rules.minLineChars || text.length > options.rules.maxLineChars) continue;

    const style = styleScore({
      fontSize: line.fontSize,
      bodyFontSize,
      isBold: line.isBold,
      fontChanged: Boolean(bodyFontName && line.fontName !== bodyFontName),
    });
    const pattern = patternScore(text);
    const semantic = semanticScore(text);
    const position = positionScore(line.topRatio);
    const total = totalScore({ weights: options.scoreWeights, style, position, pattern, semantic });

    if (
      style < options.rules.minStyleCandidate &&
      pattern < options.rules.minPatternCandidate &&
      semantic < options.rules.minSemanticCandidate
    ) {
      continue;
    }

    const count = pageCandidateCounts.get(line.pageIndex) ?? 0;
    if (count >= options.rules.maxCandidatesPerPage) continue;
    pageCandidateCounts.set(line.pageIndex, count + 1);
    scoredLines.push({ line, text, style, position, pattern, semantic, total });
  }

  if (scoredLines.length === 0) return { candidates: [], ruleStats: emptyStats() };

  const sizeToLevel = buildFontBucket(scoredLines);
  const candidates = scoredLines.map((scored) => {
    const levelHint = inferNumberedLevel(scored.text) ?? sizeToLevel.get(scored.line.fontSize) ?? 1;
    return {
      pageIndex: scored.line.pageIndex,
      text: scored.text,
      bbox: scored.line.bbox,
      source: "text" as const,
      styleScore: scored.style,
      positionScore: scored.position,
      patternScore: scored.pattern,
      semanticScore: scored.semantic,
      totalScore: scored.total,
      levelHint: Math.max(1, Math.min(6, levelHint)),
    };
  });

  return { candidates, ruleStats: summarizeRuleStats(scoredLines) };
}

function expandTextHeadingFragments(lines: TextLine[]): TextLine[] {
  const sorted = [...lines].sort((left, right) => left.pageIndex - right.pageIndex || left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]);
  const fragments: TextLine[] = [];
  const skipIndexes = new Set<number>();

  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const line = sorted[index];
    const nextLine = sorted[index + 1];
    if (!shouldCombineTextHeading(line, nextLine)) continue;

    let combined = combineTextLines(line, nextLine);
    skipIndexes.add(index);
    skipIndexes.add(index + 1);

    if (index + 2 < sorted.length && shouldExtendTextHeading(combined, nextLine, sorted[index + 2])) {
      combined = combineTextLines(combined, sorted[index + 2]);
      skipIndexes.add(index + 2);
    }
    fragments.push(combined);
  }

  sorted.forEach((line, index) => {
    if (!skipIndexes.has(index)) fragments.push(line);
  });
  return fragments.sort((left, right) => left.pageIndex - right.pageIndex || left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]);
}

function shouldCombineTextHeading(line: TextLine, nextLine: TextLine): boolean {
  if (line.pageIndex !== nextLine.pageIndex) return false;
  const compact = compactTitle(line.text);
  if (!/^(第[零一二三四五六七八九十百千万〇\d]+[卷章]|绪论|尾声|附录)$/u.test(compact)) return false;
  if (line.topRatio > 0.35 || nextLine.topRatio > 0.38) return false;
  const verticalGap = nextLine.bbox[1] - line.bbox[3];
  if (verticalGap < -2.0 || verticalGap > Math.max(50.0, textLineHeight(line) * 2.4)) return false;
  if (normalizeCandidateTitle(nextLine.text).length > 32) return false;
  return nextLine.fontSize >= line.fontSize * 0.65;
}

function shouldExtendTextHeading(combined: TextLine, second: TextLine, third: TextLine): boolean {
  if (combined.pageIndex !== third.pageIndex) return false;
  if (normalizeCandidateTitle(third.text).length > 24) return false;
  if (third.fontSize < second.fontSize * 0.8) return false;
  if (third.fontSize > second.fontSize * 1.2) return false;
  const verticalGap = third.bbox[1] - second.bbox[3];
  if (verticalGap < -2.0 || verticalGap > Math.max(36.0, textLineHeight(second) * 2.0)) return false;
  const compact = compactTitle(third.text);
  return !/^[一二三四五六七八九十]+/u.test(compact);
}

function combineTextLines(first: TextLine, second: TextLine): TextLine {
  const bbox = unionBBox(first.bbox, second.bbox);
  const text = joinTitleParts(first.text, second.text);
  return {
    pageIndex: first.pageIndex,
    text,
    bbox,
    fontSize: Math.max(first.fontSize, second.fontSize),
    isBold: first.isBold || second.isBold,
    fontName: first.fontName || second.fontName,
    pageHeight: first.pageHeight,
    topRatio: first.pageHeight <= 0 ? 1.0 : Math.max(0.0, Math.min(1.0, bbox[1] / first.pageHeight)),
  };
}

function joinTitleParts(first: string, second: string): string {
  const left = normalizeCandidateTitle(first);
  const right = normalizeCandidateTitle(second);
  if (!left) return right;
  if (!right) return left;
  return containsCjk(left) || containsCjk(right) ? `${left}${right}` : `${left} ${right}`;
}

function normalizeCandidateTitle(text: string): string {
  const value = normalizeTitle(text);
  if (!containsCjk(value)) return value;
  return value.replace(/\s+/gu, "").replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-]+/gu, "");
}

function compactTitle(text: string): string {
  return normalizeCandidateTitle(text).replace(/\s+/gu, "");
}

function containsCjk(value: string): boolean {
  return [...value].some((char) => char >= "\u4e00" && char <= "\u9fff");
}

function textLineHeight(line: TextLine): number {
  return Math.max(0.0, line.bbox[3] - line.bbox[1]);
}

function unionBBox(first: TextLine["bbox"], second: TextLine["bbox"]): TextLine["bbox"] {
  return [Math.min(first[0], second[0]), Math.min(first[1], second[1]), Math.max(first[2], second[2]), Math.max(first[3], second[3])];
}

function estimateBodyFontSize(lines: TextLine[]): number {
  const counts = new Map<number, number>();
  for (const line of lines) {
    if (line.fontSize <= 0) continue;
    const rounded = Math.round(line.fontSize * 10) / 10;
    counts.set(rounded, (counts.get(rounded) ?? 0) + 1);
  }
  if (counts.size === 0) return 12.0;
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0];
}

function estimateBodyFontName(lines: TextLine[], bodyFontSize: number): string {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (Math.abs(line.fontSize - bodyFontSize) > 1.0 || !line.fontName) continue;
    counts.set(line.fontName, (counts.get(line.fontName) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0][0];
}

function buildFontBucket(scoredLines: ScoredLine[]): Map<number, number> {
  const sizes = [...new Set(scoredLines.map((scored) => scored.line.fontSize))].sort((left, right) => right - left);
  return new Map(sizes.map((size, index) => [size, Math.max(1, Math.min(6, index + 1))]));
}

function summarizeRuleStats(scoredLines: ScoredLine[]): Record<string, number> {
  return {
    avg_style_score: avg(scoredLines.map((item) => item.style)),
    avg_position_score: avg(scoredLines.map((item) => item.position)),
    avg_pattern_score: avg(scoredLines.map((item) => item.pattern)),
    avg_semantic_score: avg(scoredLines.map((item) => item.semantic)),
    avg_total_score: avg(scoredLines.map((item) => item.total)),
  };
}

export function emptyStats(): Record<string, number> {
  return {
    avg_style_score: 0.0,
    avg_position_score: 0.0,
    avg_pattern_score: 0.0,
    avg_semantic_score: 0.0,
    avg_total_score: 0.0,
  };
}

function avg(values: number[]): number {
  return values.length === 0 ? 0.0 : values.reduce((sum, value) => sum + value, 0.0) / values.length;
}
