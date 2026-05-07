import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";
import type { AppConfig } from "../types.js";

const RawConfigSchema = z.object({
  score_weights: z
    .object({
      style: z.number().optional(),
      position: z.number().optional(),
      pattern: z.number().optional(),
      semantic: z.number().optional(),
    })
    .optional(),
  thresholds: z
    .object({
      high: z.number().optional(),
      text_ratio_high: z.number().optional(),
      text_ratio_low: z.number().optional(),
      min_text_chars_per_page: z.number().int().optional(),
      max_level_jump: z.number().int().optional(),
    })
    .optional(),
  rules: z
    .object({
      min_line_chars: z.number().int().optional(),
      max_line_chars: z.number().int().optional(),
      min_style_candidate: z.number().optional(),
      min_pattern_candidate: z.number().optional(),
      min_semantic_candidate: z.number().optional(),
      max_candidates_per_page: z.number().int().optional(),
    })
    .optional(),
});

export async function loadConfig(configPath?: string | null): Promise<AppConfig> {
  const path = configPath ?? defaultConfigPath();
  let payload: unknown = {};
  try {
    const content = await readFile(path, "utf8");
    payload = YAML.parse(content) ?? {};
  } catch (error: unknown) {
    if (configPath) throw error;
  }
  const raw = RawConfigSchema.parse(payload ?? {});
  return {
    scoreWeights: {
      style: raw.score_weights?.style ?? 0.45,
      position: raw.score_weights?.position ?? 0.2,
      pattern: raw.score_weights?.pattern ?? 0.25,
      semantic: raw.score_weights?.semantic ?? 0.1,
    },
    thresholds: {
      high: raw.thresholds?.high ?? 0.68,
      textRatioHigh: raw.thresholds?.text_ratio_high ?? 0.8,
      textRatioLow: raw.thresholds?.text_ratio_low ?? 0.2,
      minTextCharsPerPage: raw.thresholds?.min_text_chars_per_page ?? 20,
      maxLevelJump: raw.thresholds?.max_level_jump ?? 1,
    },
    rules: {
      minLineChars: raw.rules?.min_line_chars ?? 2,
      maxLineChars: raw.rules?.max_line_chars ?? 120,
      minStyleCandidate: raw.rules?.min_style_candidate ?? 0.35,
      minPatternCandidate: raw.rules?.min_pattern_candidate ?? 0.5,
      minSemanticCandidate: raw.rules?.min_semantic_candidate ?? 0.5,
      maxCandidatesPerPage: raw.rules?.max_candidates_per_page ?? 80,
    },
  };
}

function defaultConfigPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return resolve(currentDir, "../configs/default.yaml");
}
