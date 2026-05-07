#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { runAddBookmarks } from "./core/pipeline.js";

export function buildProgram(): Command {
  const program = new Command();
  program.name("buque").description("Buque PDF bookmark generation CLI.").showHelpAfterError();

  program
    .command("add-bookmarks")
    .requiredOption("--input <path>", "Input PDF file path.", resolveExistingFile)
    .requiredOption("--output <path>", "Output PDF file path with bookmarks.", resolvePath)
    .option("--lang <lang>", "Language hint passed to the OCR backend.", "zh")
    .option("--enable-ocr", "Enable OCR routing for scanned or hybrid PDFs.", false)
    .option("--ocr-strategy <strategy>", "OCR strategy: toc-guided or full-page. Defaults to toc-guided.")
    .option("--ocr-parallelism <count>", "Maximum OCR worker processes. 1 keeps OCR serial.", parsePositiveInt, 1)
    .option("--enable-llm", "Reserved LLM switch for future stages.", false)
    .option("--report <path>", "Path to output report json.", resolvePath, resolvePath("report.json"))
    .option("--toc-json <path>", "Path to output toc json.", resolvePath, resolvePath("toc.json"))
    .option("--config <path>", "Optional YAML config path.", resolveExistingFile)
    .action(async (options: Record<string, unknown>) => {
      const result = await runAddBookmarks({
        inputPath: String(options.input),
        outputPath: String(options.output),
        reportPath: String(options.report),
        tocJsonPath: String(options.tocJson),
        lang: String(options.lang),
        enableOcr: Boolean(options.enableOcr),
        enableLlm: Boolean(options.enableLlm),
        configPath: options.config ? String(options.config) : undefined,
        ocrStrategy: options.ocrStrategy ? String(options.ocrStrategy) : undefined,
        ocrParallelism: Number(options.ocrParallelism),
      });
      if (result.success) {
        process.stdout.write(`${result.message}\n`);
        return;
      }
      process.stderr.write(`${result.message}\n`);
      process.exitCode = result.exitCode;
    });

  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await buildProgram().parseAsync(process.argv);
}

function resolvePath(value: string): string {
  return resolve(value);
}

function resolveExistingFile(value: string): string {
  const path = resolve(value);
  if (!existsSync(path)) throw new InvalidArgumentError(`File does not exist: ${value}`);
  return path;
}

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError("Value must be an integer greater than or equal to 1.");
  return parsed;
}
