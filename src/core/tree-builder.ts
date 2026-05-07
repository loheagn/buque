import type { CandidateHeading, TocNode } from "../types.js";
import { normalizeTitle } from "./scorer.js";

const STRUCTURAL_HEADING_RE = /^\s*(第[零一二三四五六七八九十百千万〇\d]+[卷章])/u;
const CHINESE_VOLUME_RE = /^第[零一二三四五六七八九十百千万〇\d]+卷/u;
const CHINESE_CHAPTER_RE = /^第[零一二三四五六七八九十百千万〇\d]+章/u;

export interface BuildTreeResult {
  tocNodes: TocNode[];
  rejectedNodes: Array<Record<string, unknown>>;
}

export function buildTocNodes(candidates: CandidateHeading[], options: { maxLevelJump?: number } = {}): BuildTreeResult {
  const maxLevelJump = options.maxLevelJump ?? 1;
  const sortedCandidates = [...candidates].sort((left, right) => {
    return left.pageIndex - right.pageIndex || left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0];
  });
  const seen = new Set<string>();
  const seenStructuralKeys = new Set<string>();
  const tocNodes: TocNode[] = [];
  const rejectedNodes: Array<Record<string, unknown>> = [];
  let previousLevel: number | undefined;
  let seenVolume = false;

  for (const candidate of sortedCandidates) {
    const title = normalizeTitle(candidate.text);
    if (!title) {
      rejectedNodes.push(reject(candidate, "empty_title"));
      continue;
    }

    const dedupeKey = `${candidate.pageIndex}\u0000${title.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      rejectedNodes.push(reject(candidate, "duplicate_same_page"));
      continue;
    }
    seen.add(dedupeKey);

    const structuralKey = structuralKeyFor(title);
    if (structuralKey && seenStructuralKeys.has(structuralKey)) {
      rejectedNodes.push(reject(candidate, "duplicate_structural_heading"));
      continue;
    }
    if (structuralKey) seenStructuralKeys.add(structuralKey);

    const compact = title.replace(/\s+/gu, "");
    let level = Math.max(1, Math.min(6, candidate.levelHint ?? 1));
    if (CHINESE_VOLUME_RE.test(compact)) {
      seenVolume = true;
      level = 1;
    } else if (seenVolume && CHINESE_CHAPTER_RE.test(compact)) {
      level = Math.max(level, 2);
    }
    if (previousLevel === undefined && level > 1) level = 1;
    if (previousLevel !== undefined && level > previousLevel + maxLevelJump) level = previousLevel + maxLevelJump;
    previousLevel = level;

    tocNodes.push({
      title,
      level,
      pageIndex: Math.max(0, candidate.pageIndex),
      confidence: Math.max(0.0, Math.min(1.0, candidate.totalScore)),
      source: "rule",
    });
  }

  return { tocNodes, rejectedNodes };
}

function reject(candidate: CandidateHeading, reason: string): Record<string, unknown> {
  return {
    page_index: candidate.pageIndex,
    title: candidate.text,
    reason,
    score: candidate.totalScore,
  };
}

function structuralKeyFor(title: string): string {
  const matched = STRUCTURAL_HEADING_RE.exec(title.replace(/\s+/gu, ""));
  return matched?.[1] ?? "";
}
