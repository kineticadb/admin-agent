/**
 * Tests for the system-prompt token-budget tripwire — estimateTokens + checkPromptBudget.
 */

import { describe, it, expect } from "vitest";

import {
  estimateTokens,
  checkPromptBudget,
  DEFAULT_PROMPT_BUDGET_TOKENS,
} from "./prompt-budget.js";

// CHARS_PER_TOKEN is 4 internally; tests derive expected values from that ratio
// without importing the constant (it's an implementation detail).

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("rounds up partial tokens (ceil of length / 4)", () => {
    expect(estimateTokens("abcd")).toBe(1); // 4 chars  → 1 token
    expect(estimateTokens("abcde")).toBe(2); // 5 chars  → ceil(1.25) = 2
    expect(estimateTokens("abcdefghij")).toBe(3); // 10 chars → ceil(2.5) = 3
  });

  it("scales linearly with length", () => {
    expect(estimateTokens("x".repeat(4000))).toBe(1000);
  });

  it("never throws on falsy input", () => {
    // Typed as string, but the boundary must degrade gracefully (never throw).
    expect(() => estimateTokens("")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// checkPromptBudget
// ---------------------------------------------------------------------------

describe("checkPromptBudget", () => {
  it("reports not-over-budget for a short prompt under the default threshold", () => {
    const report = checkPromptBudget("a short prompt");
    expect(report.overBudget).toBe(false);
    expect(report.threshold).toBe(DEFAULT_PROMPT_BUDGET_TOKENS);
    expect(report.chars).toBe("a short prompt".length);
    expect(report.tokens).toBe(estimateTokens("a short prompt"));
  });

  it("reports over-budget when the estimate exceeds the default threshold", () => {
    // 4 chars/token → exceed the default by one token's worth of characters.
    const prompt = "x".repeat((DEFAULT_PROMPT_BUDGET_TOKENS + 1) * 4);
    const report = checkPromptBudget(prompt);
    expect(report.overBudget).toBe(true);
    expect(report.tokens).toBeGreaterThan(DEFAULT_PROMPT_BUDGET_TOKENS);
  });

  it("treats the threshold as strictly-greater (boundary is not over budget)", () => {
    // Exactly threshold tokens → NOT over budget.
    const prompt = "x".repeat(DEFAULT_PROMPT_BUDGET_TOKENS * 4);
    const report = checkPromptBudget(prompt);
    expect(report.tokens).toBe(DEFAULT_PROMPT_BUDGET_TOKENS);
    expect(report.overBudget).toBe(false);
  });

  it("respects a custom warnAtTokens threshold (low → over)", () => {
    const report = checkPromptBudget("x".repeat(8), { warnAtTokens: 1 });
    expect(report.tokens).toBe(2);
    expect(report.threshold).toBe(1);
    expect(report.overBudget).toBe(true);
  });

  it("respects a custom warnAtTokens threshold (high → under)", () => {
    const report = checkPromptBudget("x".repeat(8), { warnAtTokens: 1_000_000 });
    expect(report.overBudget).toBe(false);
  });

  it("returns a zeroed report for an empty prompt", () => {
    const report = checkPromptBudget("");
    expect(report.tokens).toBe(0);
    expect(report.chars).toBe(0);
    expect(report.overBudget).toBe(false);
  });
});
