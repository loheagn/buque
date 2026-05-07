import type { ScoreWeights } from "../types.js";

const CHINESE_CHAPTER_RE = /^\s*第[零一二三四五六七八九十百千万〇\d]+章/u;
const CHINESE_SECTION_RE = /^\s*第[零一二三四五六七八九十百千万〇\d]+节/u;
const CHINESE_VOLUME_RE = /^\s*第[零一二三四五六七八九十百千万〇\d]+卷/u;
const ENGLISH_CHAPTER_RE = /^\s*chapter\s+\d+\b/iu;
const ENGLISH_SECTION_RE = /^\s*section\s+\d+\b/iu;
const APPENDIX_RE = /^\s*(?:附录|appendix\b)/iu;
const FRONT_OR_TAIL_RE = /^\s*(绪论|尾声|后记)/u;
const FRONT_MATTER_RE = /^\s*(封面|作者简介|目录|图表目录|序言|第[二三四五六七八九十]+版序言)/u;
const BACK_MATTER_RE = /^\s*(参考文献|索引|.*(?:著作|书目|文献).*目录\s*$)/u;
const DECIMAL_HEADING_RE = /^\s*(\d+(?:\.\d+){0,5})(?:\s+|$)/u;
const SPACES_RE = /\s+/gu;

const SEMANTIC_KEYWORDS = [
  "前言",
  "序",
  "序言",
  "绪论",
  "引言",
  "目录",
  "附录",
  "参考文献",
  "总结",
  "封面",
  "作者简介",
  "图表目录",
  "后记",
  "尾声",
  "abstract",
  "contents",
  "appendix",
];

export function normalizeTitle(text: string): string {
  return text.trim().replace(SPACES_RE, " ");
}

export function positionScore(topRatio: number): number {
  const ratio = clamp(topRatio);
  if (ratio <= 0.2) return 1.0;
  if (ratio <= 0.4) return 0.6;
  if (ratio <= 0.6) return 0.3;
  return 0.1;
}

export function patternScore(text: string): number {
  const value = normalizeTitle(text);
  if (!value) return 0.0;
  if (
    CHINESE_VOLUME_RE.test(value) ||
    CHINESE_CHAPTER_RE.test(value) ||
    ENGLISH_CHAPTER_RE.test(value) ||
    APPENDIX_RE.test(value) ||
    FRONT_OR_TAIL_RE.test(value) ||
    FRONT_MATTER_RE.test(value) ||
    BACK_MATTER_RE.test(value)
  ) {
    return 1.0;
  }
  if (CHINESE_SECTION_RE.test(value) || ENGLISH_SECTION_RE.test(value)) return 0.9;
  if (DECIMAL_HEADING_RE.test(value)) return 1.0;
  return 0.0;
}

export function semanticScore(text: string): number {
  const value = normalizeTitle(text).toLowerCase();
  if (!value) return 0.0;
  return SEMANTIC_KEYWORDS.some((keyword) => value.includes(keyword)) ? 0.6 : 0.0;
}

export function inferNumberedLevel(text: string): number | undefined {
  const value = normalizeTitle(text);
  if (!value) return undefined;
  if (
    CHINESE_VOLUME_RE.test(value) ||
    CHINESE_CHAPTER_RE.test(value) ||
    ENGLISH_CHAPTER_RE.test(value) ||
    APPENDIX_RE.test(value) ||
    FRONT_OR_TAIL_RE.test(value) ||
    FRONT_MATTER_RE.test(value) ||
    BACK_MATTER_RE.test(value)
  ) {
    return 1;
  }
  if (CHINESE_SECTION_RE.test(value) || ENGLISH_SECTION_RE.test(value)) return 2;
  const matched = DECIMAL_HEADING_RE.exec(value);
  if (!matched) return undefined;
  return Math.max(1, Math.min(6, matched[1].split(".").length));
}

export function styleScore(options: {
  fontSize: number;
  bodyFontSize: number;
  isBold: boolean;
  fontChanged: boolean;
}): number {
  const baseline = options.bodyFontSize > 0 ? options.bodyFontSize : options.fontSize;
  const ratio = baseline <= 0 ? 1.0 : options.fontSize / baseline;
  const sizeComponent = clamp((ratio - 1.0) / 0.55);
  const boldComponent = options.isBold ? 1.0 : 0.0;
  const fontComponent = options.fontChanged ? 1.0 : 0.0;
  return clamp(0.6 * sizeComponent + 0.3 * boldComponent + 0.1 * fontComponent);
}

export function totalScore(options: {
  weights: ScoreWeights;
  style: number;
  position: number;
  pattern: number;
  semantic: number;
}): number {
  const { weights, style, position, pattern, semantic } = options;
  return clamp(weights.style * style + weights.position * position + weights.pattern * pattern + weights.semantic * semantic);
}

export function clamp(value: number, minimum = 0.0, maximum = 1.0): number {
  return Math.max(minimum, Math.min(maximum, value));
}
