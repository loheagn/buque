export type DocumentType = "text" | "scanned" | "hybrid";
export type HeadingSource = "text" | "ocr";
export type TocSource = "rule" | "llm" | "merged";
export type BBox = [number, number, number, number];

export interface TextLine {
  pageIndex: number;
  text: string;
  bbox: BBox;
  fontSize: number;
  isBold: boolean;
  fontName: string;
  pageHeight: number;
  topRatio: number;
}

export interface CandidateHeading {
  pageIndex: number;
  text: string;
  bbox: BBox;
  source: HeadingSource;
  styleScore: number;
  positionScore: number;
  patternScore: number;
  semanticScore: number;
  totalScore: number;
  levelHint?: number;
}

export interface TocNode {
  title: string;
  level: number;
  pageIndex: number;
  confidence: number;
  source: TocSource;
}

export interface OCRTextLine {
  text: string;
  bbox?: BBox | null;
  confidence?: number | null;
}

export type OCRLine = string | OCRTextLine;

export interface OCRBackend {
  extract(options: { pageImageBytes: Uint8Array; lang: string }): Promise<OCRLine[]> | OCRLine[];
}

export interface ClassificationResult {
  docType: DocumentType;
  pageCount: number;
  textPages: number;
  textPageRatio: number;
  pageCharCounts: number[];
}

export interface ScoreWeights {
  style: number;
  position: number;
  pattern: number;
  semantic: number;
}

export interface Thresholds {
  high: number;
  textRatioHigh: number;
  textRatioLow: number;
  minTextCharsPerPage: number;
  maxLevelJump: number;
}

export interface RuleConfig {
  minLineChars: number;
  maxLineChars: number;
  minStyleCandidate: number;
  minPatternCandidate: number;
  minSemanticCandidate: number;
  maxCandidatesPerPage: number;
}

export interface AppConfig {
  scoreWeights: ScoreWeights;
  thresholds: Thresholds;
  rules: RuleConfig;
}

export interface PipelineResult {
  success: boolean;
  exitCode: number;
  message: string;
  report: Record<string, unknown>;
  tocNodes: TocNode[];
}
