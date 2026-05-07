import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { outlinePdfFactory } from "@lillallol/outline-pdf";
import * as pdfLib from "pdf-lib";
import type { TocNode } from "../types.js";

export async function writeBookmarks(options: { inputPath: string; outputPath: string; tocNodes: TocNode[] }): Promise<void> {
  await mkdir(dirname(options.outputPath), { recursive: true });
  const sameFile = resolve(options.inputPath) === resolve(options.outputPath);
  const targetPath = sameFile ? `${options.outputPath}.tmp` : options.outputPath;
  try {
    if (options.tocNodes.length === 0) {
      await copyFile(options.inputPath, targetPath);
    } else {
      const pdf = await readFile(options.inputPath);
      const outline = outlineText(options.tocNodes);
      const outlinePdf = outlinePdfFactory(pdfLib);
      const outlinedDocument = await outlinePdf({ pdf, outline });
      await writeFile(targetPath, await outlinedDocument.save());
    }
    if (sameFile) await rename(targetPath, options.outputPath);
  } catch (error) {
    if (sameFile) await rm(targetPath, { force: true });
    throw error;
  }
}

function outlineText(tocNodes: TocNode[]): string {
  return tocNodes
    .map((node) => {
      const pageNumber = Math.max(1, node.pageIndex + 1);
      const depth = "-".repeat(Math.max(0, node.level - 1));
      return `${pageNumber}|${depth}|${node.title}`;
    })
    .join("\n");
}
