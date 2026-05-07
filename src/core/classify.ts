import type { ClassificationResult, DocumentType } from "../types.js";
import type { PdfDocument } from "../pdf/document.js";

const WHITESPACE_RE = /\s+/gu;

export async function classifyDocument(
  doc: PdfDocument,
  options: { textRatioHigh: number; textRatioLow: number; minTextCharsPerPage: number },
): Promise<ClassificationResult> {
  const pageCharCounts: number[] = [];
  let textPages = 0;
  for (let pageIndex = 0; pageIndex < doc.pageCount; pageIndex += 1) {
    const raw = await doc.pageText(pageIndex);
    const charCount = raw.replace(WHITESPACE_RE, "").length;
    pageCharCounts.push(charCount);
    if (charCount >= options.minTextCharsPerPage) textPages += 1;
  }
  const pageCount = pageCharCounts.length;
  const textPageRatio = pageCount === 0 ? 0.0 : textPages / pageCount;
  let docType: DocumentType;
  if (textPageRatio >= options.textRatioHigh) {
    docType = "text";
  } else if (textPageRatio <= options.textRatioLow) {
    docType = "scanned";
  } else {
    docType = "hybrid";
  }
  return { docType, pageCount, textPages, textPageRatio, pageCharCounts };
}
