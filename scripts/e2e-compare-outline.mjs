import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, PDFName } from "pdf-lib";

const inputPath = resolve(process.argv[2] ?? "test-with-toc.pdf");
const outputDir = resolve(process.argv[3] ?? "e2e-output");

await mkdir(outputDir, { recursive: true });

const originalOutlinePath = resolve(outputDir, "original-outline.json");
const strippedPath = resolve(outputDir, "test-without-toc.pdf");
const generatedPdfPath = resolve(outputDir, "generated.pdf");
const generatedTocPath = resolve(outputDir, "generated-toc.json");
const reportPath = resolve(outputDir, "report.json");
const comparisonPath = resolve(outputDir, "comparison.json");

const original = await inspectPdf(inputPath);
await writeFile(originalOutlinePath, JSON.stringify(original, null, 2));

await stripOutline(inputPath, strippedPath);
const stripped = await inspectPdf(strippedPath);
if (stripped.outline.length !== 0) {
  throw new Error(`Failed to strip outline from ${inputPath}.`);
}

await runCli([
  "dist/cli.js",
  "add-bookmarks",
  "--input",
  strippedPath,
  "--output",
  generatedPdfPath,
  "--report",
  reportPath,
  "--toc-json",
  generatedTocPath,
]);

const generated = JSON.parse(await readFile(generatedTocPath, "utf8"));
const comparison = compareOutlines(original.outline, generated);
await writeFile(comparisonPath, JSON.stringify(comparison, null, 2));

console.log(
  JSON.stringify(
    {
      input: inputPath,
      output_dir: outputDir,
      page_count: original.page_count,
      original_count: comparison.original_count,
      generated_count: comparison.generated_count,
      matched_count: comparison.matched_count,
      recall: comparison.recall,
      precision: comparison.precision,
      exact_page_matches: comparison.exact_page_matches,
      within_1_page: comparison.within_1_page,
      missed_count: comparison.missed.length,
      extra_count: comparison.extra.length,
    },
    null,
    2,
  ),
);

async function inspectPdf(path) {
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
  try {
    const outline = await flattenOutline(doc, (await doc.getOutline()) ?? []);
    let textPages = 0;
    const samples = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .filter((item) => item && typeof item.str === "string")
        .map((item) => item.str)
        .join("")
        .replace(/\s+/g, "");
      if (text.length >= 20) textPages += 1;
      if (pageNumber <= 10) samples.push({ page: pageNumber, chars: text.length, sample: text.slice(0, 120) });
    }
    return {
      page_count: doc.numPages,
      outline_count: outline.length,
      text_pages: textPages,
      text_page_ratio: doc.numPages === 0 ? 0 : textPages / doc.numPages,
      samples,
      outline,
    };
  } finally {
    await loadingTask.destroy();
  }
}

async function flattenOutline(doc, items, level = 1, out = []) {
  for (const item of items) {
    out.push({ title: item.title, level, page_index: await destPage(doc, item.dest) });
    await flattenOutline(doc, item.items ?? [], level + 1, out);
  }
  return out;
}

async function destPage(doc, dest) {
  if (!dest) return null;
  const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
  if (!Array.isArray(explicit) || explicit.length === 0) return null;
  try {
    return await doc.getPageIndex(explicit[0]);
  } catch {
    return null;
  }
}

async function stripOutline(input, output) {
  await mkdir(dirname(output), { recursive: true });
  const pdf = await PDFDocument.load(await readFile(input), { ignoreEncryption: true });
  pdf.catalog.delete(PDFName.of("Outlines"));
  pdf.catalog.delete(PDFName.of("PageMode"));
  await writeFile(output, await pdf.save());
}

function compareOutlines(original, generated) {
  const used = new Set();
  const rows = [];
  for (const [originalIndex, originalNode] of original.entries()) {
    let best = null;
    for (const [generatedIndex, generatedNode] of generated.entries()) {
      const titleSimilarity = similarity(originalNode.title, generatedNode.title);
      const titleMatched = titleOk(originalNode.title, generatedNode.title);
      const pageDelta =
        originalNode.page_index === null || generatedNode.page_index === null
          ? 999
          : Math.abs(originalNode.page_index - generatedNode.page_index);
      const score = (titleMatched ? 1 : 0) + titleSimilarity * 0.1 - Math.min(pageDelta, 50) * 0.01;
      if (!best || score > best.score) best = { generatedIndex, generatedNode, titleSimilarity, titleMatched, pageDelta, score };
    }
    const matched = Boolean(best && best.titleMatched && best.pageDelta <= 2 && !used.has(best.generatedIndex));
    if (matched) used.add(best.generatedIndex);
    rows.push({
      original_index: originalIndex,
      original_title: originalNode.title,
      original_level: originalNode.level,
      original_page: originalNode.page_index,
      matched,
      generated_index: best?.generatedIndex,
      generated_title: best?.generatedNode.title,
      generated_level: best?.generatedNode.level,
      generated_page: best?.generatedNode.page_index,
      title_similarity: Number((best?.titleSimilarity ?? 0).toFixed(3)),
      page_delta: best?.pageDelta ?? null,
    });
  }
  const matches = rows.filter((row) => row.matched);
  const extra = generated.map((node, generatedIndex) => ({ generated_index: generatedIndex, ...node })).filter((_, index) => !used.has(index));
  return {
    original_count: original.length,
    generated_count: generated.length,
    matched_count: matches.length,
    recall: original.length === 0 ? 0 : Number((matches.length / original.length).toFixed(3)),
    precision: generated.length === 0 ? 0 : Number((matches.length / generated.length).toFixed(3)),
    exact_page_matches: matches.filter((row) => row.page_delta === 0).length,
    within_1_page: matches.filter((row) => row.page_delta <= 1).length,
    within_2_pages: matches.filter((row) => row.page_delta <= 2).length,
    matches,
    missed: rows.filter((row) => !row.matched),
    extra,
  };
}

function titleOk(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.startsWith(b) && b.length >= 2) return true;
  if (b.startsWith(a) && a.length >= 2) return true;
  return similarity(left, right) >= 0.72;
}

function similarity(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return (2 * lcs(a, b)) / Math.max(1, a.length + b.length);
}

function lcs(left, right) {
  const a = [...left];
  const b = [...right];
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\s　!！?？:：,，.。;；、·《》“”"'()[\]（）【】\-—_．…]/g, "");
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`CLI exited with code ${code}.`));
    });
  });
}

function pdfJsAssetPath(name) {
  return `${resolve(dirname(fileURLToPath(import.meta.url)), "../node_modules/pdfjs-dist", name)}/`;
}
