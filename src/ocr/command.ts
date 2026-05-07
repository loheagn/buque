import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { OCRBackend, OCRLine } from "../types.js";

export class CommandOCRBackend implements OCRBackend {
  readonly kind = "command";

  constructor(
    public readonly commandTemplate: string,
    public readonly timeoutSeconds = 60,
  ) {}

  static fromEnvironment(): CommandOCRBackend | undefined {
    const command = process.env.BUQUE_OCR_COMMAND?.trim();
    return command ? new CommandOCRBackend(command) : undefined;
  }

  async extract(options: { pageImageBytes: Uint8Array; lang: string }): Promise<OCRLine[]> {
    const tempDir = await mkdtemp(join(tmpdir(), "buque-ocr-"));
    const imagePath = join(tempDir, "page.png");
    try {
      await writeFile(imagePath, options.pageImageBytes);
      const command = this.buildCommand(imagePath, options.lang);
      const completed = await runCommand(command, this.timeoutSeconds);
      if (completed.code !== 0) {
        const detail = completed.stderr.trim() || completed.stdout.trim() || "unknown OCR command failure";
        throw new Error(`OCR command failed with exit code ${completed.code}: ${detail}`);
      }
      return completed.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  buildCommand(imagePath: string, lang: string): string[] {
    if (this.commandTemplate.includes("{image}") || this.commandTemplate.includes("{lang}")) {
      return parseCommand(
        this.commandTemplate.replaceAll("{image}", shellQuote(imagePath)).replaceAll("{lang}", shellQuote(lang)),
      );
    }
    return [...parseCommand(this.commandTemplate), imagePath, lang];
  }
}

export class NoopOCRBackend implements OCRBackend {
  readonly kind = "noop";

  extract(): OCRLine[] {
    return [];
  }
}

export function resolveOCRBackend(backend?: OCRBackend | null): OCRBackend {
  if (backend) return backend;
  return CommandOCRBackend.fromEnvironment() ?? new NoopOCRBackend();
}

export function isRebuildableCommandBackend(backend: OCRBackend): backend is CommandOCRBackend {
  return backend instanceof CommandOCRBackend;
}

function runCommand(command: string[], timeoutSeconds: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`OCR command timed out after ${timeoutSeconds} seconds.`));
    }, timeoutSeconds * 1000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parseCommand(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === "\"") && quote === undefined) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      continue;
    }
    if (/\s/u.test(char) && quote === undefined) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (current) args.push(current);
  return args;
}
