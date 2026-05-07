import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api.js";
import type { BBox, TextLine } from "../types.js";

const WHITESPACE_RE = /\s+/gu;

interface RawTextItem {
  text: string;
  bbox: BBox;
  fontSize: number;
  fontName: string;
  isBold: boolean;
  hasEOL: boolean;
}

export interface PageSize {
  width: number;
  height: number;
}

export class PdfDocument {
  private constructor(
    private readonly loadingTask: pdfjs.PDFDocumentLoadingTask,
    private readonly doc: PDFDocumentProxy,
  ) {}

  static async open(path: string): Promise<PdfDocument> {
    const data = new Uint8Array(await readFile(path));
    const loadingTask = pdfjs.getDocument({
      data,
      useSystemFonts: true,
      cMapUrl: pdfJsAssetPath("cmaps"),
      cMapPacked: true,
      standardFontDataUrl: pdfJsAssetPath("standard_fonts"),
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
    const doc = await loadingTask.promise;
    return new PdfDocument(loadingTask, doc);
  }

  get pageCount(): number {
    return this.doc.numPages;
  }

  async getPageSize(pageIndex: number): Promise<PageSize> {
    const page = await this.page(pageIndex);
    const viewport = page.getViewport({ scale: 1.0 });
    return { width: viewport.width, height: viewport.height };
  }

  async pageText(pageIndex: number): Promise<string> {
    const page = await this.page(pageIndex);
    const content = await page.getTextContent();
    return content.items
      .filter(isTextItem)
      .map((item) => item.str)
      .join("");
  }

  async extractTextLines(): Promise<TextLine[]> {
    const lines: TextLine[] = [];
    for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex += 1) {
      const page = await this.page(pageIndex);
      const viewport = page.getViewport({ scale: 1.0 });
      const content = await page.getTextContent();
      const items: RawTextItem[] = [];
      for (const item of content.items) {
        if (!isTextItem(item)) continue;
        const text = item.str.trim();
        if (!text) continue;
        const style = content.styles[item.fontName];
        const fontName = style?.fontFamily || item.fontName || "";
        const fontSize = estimateFontSize(item);
        items.push({
          text,
          bbox: itemBBox(item, viewport.height),
          fontSize,
          fontName,
          isBold: /bold|black|heavy/iu.test(`${fontName} ${item.fontName}`),
          hasEOL: item.hasEOL,
        });
      }
      lines.push(...itemsToLines(items, pageIndex, viewport.height));
    }
    lines.sort((left, right) => left.pageIndex - right.pageIndex || left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0]);
    return lines;
  }

  async renderPagePng(pageIndex: number, scale: number): Promise<Uint8Array> {
    const page = await this.page(pageIndex);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const canvasContext = canvas.getContext("2d");
    await page
      .render({
        canvasContext: canvasContext as unknown as CanvasRenderingContext2D,
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport,
      })
      .promise;
    return new Uint8Array(canvas.toBuffer("image/png"));
  }

  async destroy(): Promise<void> {
    await this.loadingTask.destroy();
  }

  private async page(pageIndex: number): Promise<PDFPageProxy> {
    if (pageIndex < 0 || pageIndex >= this.pageCount) throw new RangeError(`Invalid page index: ${pageIndex}`);
    return this.doc.getPage(pageIndex + 1);
  }
}

function pdfJsAssetPath(name: string): string {
  return `${join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/pdfjs-dist", name)}/`;
}

function isTextItem(item: unknown): item is TextItem {
  return typeof item === "object" && item !== null && "str" in item && "transform" in item;
}

function estimateFontSize(item: TextItem): number {
  const [, b, , d] = item.transform.map(Number);
  const transformed = Math.hypot(b, d);
  return Math.max(0.0, Number.isFinite(transformed) && transformed > 0 ? transformed : item.height);
}

function itemBBox(item: TextItem, pageHeight: number): BBox {
  const transform = item.transform.map(Number);
  const x = transform[4] || 0.0;
  const baselineY = transform[5] || 0.0;
  const height = Math.max(0.0, item.height || estimateFontSize(item));
  const width = Math.max(0.0, item.width || 0.0);
  const top = Math.max(0.0, pageHeight - baselineY - height);
  return [x, top, x + width, top + height];
}

function itemsToLines(items: RawTextItem[], pageIndex: number, pageHeight: number): TextLine[] {
  const clusters: RawTextItem[][] = [];
  for (const item of [...items].sort((left, right) => left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0])) {
    const centerY = (item.bbox[1] + item.bbox[3]) / 2.0;
    const cluster = clusters.find((candidate) => {
      const first = candidate[0];
      const firstCenterY = (first.bbox[1] + first.bbox[3]) / 2.0;
      return Math.abs(firstCenterY - centerY) <= Math.max(2.0, Math.min(item.bbox[3] - item.bbox[1], first.bbox[3] - first.bbox[1]) * 0.5);
    });
    if (cluster && !cluster.at(-1)?.hasEOL) {
      cluster.push(item);
    } else {
      clusters.push([item]);
    }
  }

  return clusters
    .map((cluster) => {
      const sorted = cluster.sort((left, right) => left.bbox[0] - right.bbox[0]);
      const text = joinLineText(sorted);
      const bbox = unionBBoxes(sorted.map((item) => item.bbox));
      const fontSize = Math.max(...sorted.map((item) => item.fontSize));
      const fontName = sorted[0]?.fontName ?? "";
      const line: TextLine = {
        pageIndex,
        text,
        bbox,
        fontSize,
        isBold: sorted.some((item) => item.isBold),
        fontName,
        pageHeight,
        topRatio: pageHeight <= 0 ? 1.0 : Math.max(0.0, Math.min(1.0, bbox[1] / pageHeight)),
      };
      return line;
    })
    .filter((line) => line.text.length > 0);
}

function joinLineText(items: RawTextItem[]): string {
  let result = "";
  for (const item of items) {
    if (!result) {
      result = item.text;
      continue;
    }
    const previous = items[items.indexOf(item) - 1];
    const gap = previous ? item.bbox[0] - previous.bbox[2] : 0.0;
    result += gap > Math.max(2.0, item.fontSize * 0.2) ? ` ${item.text}` : item.text;
  }
  return result.replace(WHITESPACE_RE, " ").trim();
}

function unionBBoxes(boxes: BBox[]): BBox {
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ];
}
