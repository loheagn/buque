import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PDFDocument, rgb, StandardFonts, type PDFPage } from "pdf-lib";

export async function buildTextPdf(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage();
  drawTextTop(page1, "Chapter 1 Introduction", 72, 72, 22, font);
  drawTextTop(page1, "This is body text for chapter one.", 72, 120, 12, font);

  const page2 = doc.addPage();
  drawTextTop(page2, "1.1 Background", 72, 72, 18, font);
  drawTextTop(page2, "Additional body text for section 1.1.", 72, 120, 12, font);
  drawTextTop(page2, "1.2 Scope", 72, 300, 18, font);
  drawTextTop(page2, "Additional body text for section 1.2.", 72, 348, 12, font);
  await writeFile(path, await doc.save());
}

export async function buildScannedLikePdf(path: string, pageCount = 1): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const doc = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    const page = doc.addPage();
    page.drawRectangle({
      x: 50,
      y: 142,
      width: 450,
      height: 650,
      color: rgb(0.9, 0.9, 0.9),
      borderColor: rgb(0, 0, 0),
    });
  }
  await writeFile(path, await doc.save());
}

export async function buildHybridPdf(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage();
  drawTextTop(page1, "Chapter 1 Text Page", 72, 72, 22, font);
  drawTextTop(page1, "This page has enough extractable body text for classification.", 72, 120, 12, font);
  const page2 = doc.addPage();
  page2.drawRectangle({
    x: 50,
    y: 142,
    width: 450,
    height: 650,
    color: rgb(0.9, 0.9, 0.9),
    borderColor: rgb(0, 0, 0),
  });
  await writeFile(path, await doc.save());
}

function drawTextTop(page: PDFPage, text: string, x: number, top: number, size: number, font: unknown): void {
  const { height } = page.getSize();
  page.drawText(text, {
    x,
    y: height - top - size,
    size,
    font: font as Parameters<PDFPage["drawText"]>[1]["font"],
    color: rgb(0, 0, 0),
  });
}
