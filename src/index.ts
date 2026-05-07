export type {
  AppConfig,
  BBox,
  CandidateHeading,
  ClassificationResult,
  DocumentType,
  OCRBackend,
  OCRLine,
  OCRTextLine,
  PipelineResult,
  RuleConfig,
  ScoreWeights,
  TextLine,
  Thresholds,
  TocNode,
} from "./types.js";
export { runAddBookmarks, type RunAddBookmarksOptions } from "./core/pipeline.js";
export { CommandOCRBackend, NoopOCRBackend } from "./ocr/command.js";
export { inferNumberedLevel, normalizeTitle, patternScore, positionScore, semanticScore, styleScore, totalScore } from "./core/scorer.js";
export { buildTocNodes } from "./core/tree-builder.js";
export { runOCRPages, extractOCRCandidates } from "./core/ocr-extract.js";
