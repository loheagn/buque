import { describe, expect, it } from "vitest";
import { inferNumberedLevel, totalScore } from "../src/core/scorer.js";

describe("scorer", () => {
  it("uses fixed score weights", () => {
    const score = totalScore({
      weights: { style: 0.45, position: 0.2, pattern: 0.25, semantic: 0.1 },
      style: 0.8,
      position: 0.5,
      pattern: 1.0,
      semantic: 0.2,
    });
    expect(Number(score.toFixed(4))).toBe(Number((0.45 * 0.8 + 0.2 * 0.5 + 0.25 * 1.0 + 0.1 * 0.2).toFixed(4)));
  });

  it("infers numbered heading levels", () => {
    expect(inferNumberedLevel("Chapter 2 Data Pipeline")).toBe(1);
    expect(inferNumberedLevel("第3章 测试策略")).toBe(1);
    expect(inferNumberedLevel("Section 2 Background")).toBe(2);
    expect(inferNumberedLevel("第2节 背景")).toBe(2);
    expect(inferNumberedLevel("1.2.3 Storage")).toBe(3);
    expect(inferNumberedLevel("random body text")).toBeUndefined();
  });
});
