import { describe, it, expect } from "vitest";
import { truncateOutput } from "./truncate";

describe("truncateOutput", () => {
  it("returns short text unchanged", () => {
    const input = "line1\nline2\nline3";
    expect(truncateOutput(input)).toBe(input);
  });

  it("truncates long text with head + tail", () => {
    // Generate 201 lines: line1..line201
    // head=150, tail=50 => truncates 1 line (line151)
    // head: line1..line150, tail: line152..line201
    const lines = Array.from({ length: 201 }, (_, i) => `line${i + 1}`);
    const input = lines.join("\n");
    const result = truncateOutput(input);

    // Result should start with first 150 lines
    expect(result.startsWith("line1\n")).toBe(true);
    expect(result.includes("line150")).toBe(true);
    // The one truncated line (line151) should NOT appear
    expect(result.includes("line151")).toBe(false);
    // Tail lines (line152..line201) should appear in the result
    expect(result.includes("line152")).toBe(true);
    expect(result.includes("line201")).toBe(true);
  });

  it("includes accurate truncation count in indicator", () => {
    // 201 lines with default 150+50: 201 - 150 - 50 = 1 line truncated
    const lines = Array.from({ length: 201 }, (_, i) => `line${i + 1}`);
    const input = lines.join("\n");
    const result = truncateOutput(input);
    expect(result).toContain("[... 1 lines truncated ...]");
  });

  it("handles empty string", () => {
    expect(truncateOutput("")).toBe("");
  });

  it("returns text unchanged at exact boundary (headLines + tailLines)", () => {
    // Exactly 200 lines = 150 + 50: no truncation
    const lines = Array.from({ length: 200 }, (_, i) => `line${i + 1}`);
    const input = lines.join("\n");
    expect(truncateOutput(input)).toBe(input);
  });

  it("truncates when one line over boundary", () => {
    // 201 lines = one over the 200 boundary
    const lines = Array.from({ length: 201 }, (_, i) => `line${i + 1}`);
    const input = lines.join("\n");
    const result = truncateOutput(input);
    expect(result).not.toBe(input);
    expect(result).toContain("[... 1 lines truncated ...]");
  });

  it("respects custom truncation options", () => {
    // 15 lines with custom 5 head + 5 tail
    const lines = Array.from({ length: 15 }, (_, i) => `line${i + 1}`);
    const input = lines.join("\n");
    const result = truncateOutput(input, { headLines: 5, tailLines: 5 });

    // Should have 5 head lines truncated, then 5 tail lines = 5 lines truncated
    expect(result).toContain("[... 5 lines truncated ...]");
    expect(result.startsWith("line1\n")).toBe(true);
    expect(result.includes("line5")).toBe(true);
    expect(result.includes("line6")).toBe(false);
    expect(result.includes("line11")).toBe(true);
    expect(result.endsWith("line15")).toBe(true);
  });

  it("truncated output has fewer lines than input", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line${i + 1}`);
    const input = lines.join("\n");
    const result = truncateOutput(input);
    const inputLineCount = input.split("\n").length;
    const resultLineCount = result.split("\n").length;
    expect(resultLineCount).toBeLessThan(inputLineCount);
  });
});
