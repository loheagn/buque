import { describe, expect, it } from "vitest";
import type { CandidateHeading } from "../src/types.js";
import { buildTocNodes } from "../src/core/tree-builder.js";

describe("tree builder", () => {
  it("deduplicates candidates and guards level jumps", () => {
    const candidates = [
      candidate({ pageIndex: 0, title: "Chapter 1", levelHint: 1, y: 10 }),
      candidate({ pageIndex: 0, title: "Chapter 1", levelHint: 1, y: 12 }),
      candidate({ pageIndex: 1, title: "Deep Section", levelHint: 4, y: 10 }),
    ];
    const result = buildTocNodes(candidates, { maxLevelJump: 1 });
    expect(result.tocNodes.map((node) => node.title)).toEqual(["Chapter 1", "Deep Section"]);
    expect(result.tocNodes.map((node) => node.level)).toEqual([1, 2]);
    expect(result.rejectedNodes).toHaveLength(1);
    expect(result.rejectedNodes[0].reason).toBe("duplicate_same_page");
  });
});

function candidate(options: { pageIndex: number; title: string; levelHint: number; y: number; score?: number }): CandidateHeading {
  return {
    pageIndex: options.pageIndex,
    text: options.title,
    bbox: [0, options.y, 100, options.y + 10],
    source: "text",
    styleScore: 0.9,
    positionScore: 0.9,
    patternScore: 0.9,
    semanticScore: 0,
    totalScore: options.score ?? 0.9,
    levelHint: options.levelHint,
  };
}
