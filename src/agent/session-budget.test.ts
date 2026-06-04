import { describe, it, expect } from "vitest";

import {
  MODEL_PRICING,
  DEFAULT_MAX_BUDGET_USD,
  DEFAULT_WARN_FRACTION,
  estimateTurnCostUsd,
  resolveMaxBudgetUsd,
  createBudgetTracker,
  fromSdkUsage,
} from "./session-budget.js";
import type { TokenUsage } from "./session-budget.js";
import { SUPPORTED_MODELS } from "./run-agent.js";

// ---------------------------------------------------------------------------
// MODEL_PRICING
// ---------------------------------------------------------------------------

describe("MODEL_PRICING", () => {
  it("has an entry for every supported model", () => {
    for (const model of SUPPORTED_MODELS) {
      expect(MODEL_PRICING[model]).toBeDefined();
    }
  });

  it("prices output at least as much as input for every model", () => {
    for (const model of SUPPORTED_MODELS) {
      const p = MODEL_PRICING[model];
      expect(p.outputPerMTok).toBeGreaterThanOrEqual(p.inputPerMTok);
      // Cache reads are the cheapest input class.
      expect(p.cacheReadPerMTok).toBeLessThan(p.inputPerMTok);
    }
  });
});

// ---------------------------------------------------------------------------
// estimateTurnCostUsd
// ---------------------------------------------------------------------------

describe("estimateTurnCostUsd", () => {
  it("returns 0 for null/undefined usage", () => {
    expect(estimateTurnCostUsd(null, "sonnet")).toBe(0);
    expect(estimateTurnCostUsd(undefined, "sonnet")).toBe(0);
  });

  it("returns 0 for empty usage", () => {
    expect(estimateTurnCostUsd({}, "sonnet")).toBe(0);
  });

  it("prices input + output tokens using the per-MTok table", () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const p = MODEL_PRICING.sonnet;
    expect(estimateTurnCostUsd(usage, "sonnet")).toBeCloseTo(p.inputPerMTok + p.outputPerMTok, 6);
  });

  it("prices cache-read and cache-creation tokens separately", () => {
    const usage: TokenUsage = {
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    };
    const p = MODEL_PRICING.opus;
    expect(estimateTurnCostUsd(usage, "opus")).toBeCloseTo(
      p.cacheReadPerMTok + p.cacheCreationPerMTok,
      6,
    );
  });

  it("treats null/negative/NaN token counts as zero (never throws)", () => {
    const usage: TokenUsage = {
      inputTokens: null,
      outputTokens: -50,
      cacheReadInputTokens: Number.NaN,
      cacheCreationInputTokens: undefined,
    };
    expect(estimateTurnCostUsd(usage, "haiku")).toBe(0);
  });

  it("scales linearly with token count", () => {
    const small: TokenUsage = { inputTokens: 1_000, outputTokens: 500 };
    const big: TokenUsage = { inputTokens: 10_000, outputTokens: 5_000 };
    expect(estimateTurnCostUsd(big, "sonnet")).toBeCloseTo(
      estimateTurnCostUsd(small, "sonnet") * 10,
      9,
    );
  });

  it("opus costs more than haiku for identical usage", () => {
    const usage: TokenUsage = { inputTokens: 100_000, outputTokens: 100_000 };
    expect(estimateTurnCostUsd(usage, "opus")).toBeGreaterThan(estimateTurnCostUsd(usage, "haiku"));
  });
});

// ---------------------------------------------------------------------------
// fromSdkUsage
// ---------------------------------------------------------------------------

describe("fromSdkUsage", () => {
  it("maps the SDK's snake_case fields to camelCase", () => {
    const usage = fromSdkUsage({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    });
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 40,
    });
  });

  it("returns all-undefined fields for null/undefined/empty input (never throws)", () => {
    const empty = {
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadInputTokens: undefined,
      cacheCreationInputTokens: undefined,
    };
    expect(fromSdkUsage(null)).toEqual(empty);
    expect(fromSdkUsage(undefined)).toEqual(empty);
    expect(fromSdkUsage({})).toEqual(empty);
  });

  it("round-trips through estimateTurnCostUsd", () => {
    const usage = fromSdkUsage({ output_tokens: 1_000_000 });
    expect(estimateTurnCostUsd(usage, "sonnet")).toBeCloseTo(MODEL_PRICING.sonnet.outputPerMTok, 6);
  });
});

// ---------------------------------------------------------------------------
// resolveMaxBudgetUsd
// ---------------------------------------------------------------------------

describe("resolveMaxBudgetUsd", () => {
  it("returns the default when no flag and no env", () => {
    expect(resolveMaxBudgetUsd(undefined, {})).toBe(DEFAULT_MAX_BUDGET_USD);
  });

  it("prefers a valid flag value over env and default", () => {
    expect(resolveMaxBudgetUsd(12.5, { ADMIN_AGENT_MAX_BUDGET: "7" })).toBe(12.5);
  });

  it("falls back to a valid env value when no flag", () => {
    expect(resolveMaxBudgetUsd(undefined, { ADMIN_AGENT_MAX_BUDGET: "7.25" })).toBe(7.25);
  });

  it("ignores an invalid flag and falls through to env", () => {
    // The CLI is expected to reject bad flags before calling, but the resolver
    // must still be defensive.
    expect(resolveMaxBudgetUsd(0, { ADMIN_AGENT_MAX_BUDGET: "9" })).toBe(9);
    expect(resolveMaxBudgetUsd(-3, { ADMIN_AGENT_MAX_BUDGET: "9" })).toBe(9);
    expect(resolveMaxBudgetUsd(Number.NaN, { ADMIN_AGENT_MAX_BUDGET: "9" })).toBe(9);
  });

  it.each(["abc", "0", "-1", ""])(
    "ignores an invalid env value (%s) and falls back to the default",
    (bad) => {
      expect(resolveMaxBudgetUsd(undefined, { ADMIN_AGENT_MAX_BUDGET: bad })).toBe(
        DEFAULT_MAX_BUDGET_USD,
      );
    },
  );

  it("defaults the env arg to process.env when omitted", () => {
    // Should not throw and should return a positive number.
    expect(resolveMaxBudgetUsd()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createBudgetTracker
// ---------------------------------------------------------------------------

describe("createBudgetTracker", () => {
  it("accumulates estimated spend across turns", () => {
    const tracker = createBudgetTracker({ maxUsd: 100 });
    expect(tracker.spentUsd()).toBe(0);
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    tracker.add(usage, "sonnet");
    const afterOne = tracker.spentUsd();
    expect(afterOne).toBeGreaterThan(0);
    tracker.add(usage, "sonnet");
    expect(tracker.spentUsd()).toBeCloseTo(afterOne * 2, 6);
  });

  it("does not warn before spend crosses the warn fraction", () => {
    const tracker = createBudgetTracker({ maxUsd: 1000, warnFraction: 0.8 });
    tracker.add({ inputTokens: 1_000_000 }, "sonnet"); // ~$3, well under $800
    expect(tracker.shouldWarn()).toBe(false);
  });

  it("warns once spend strictly exceeds the warn threshold, then only once", () => {
    // warnAt = 0.8 * maxUsd. Pick a tiny budget so a single turn crosses it.
    const tracker = createBudgetTracker({ maxUsd: 0.01, warnFraction: 0.8 });
    tracker.add({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, "opus"); // ~$90
    expect(tracker.shouldWarn()).toBe(true);
    tracker.markWarned();
    expect(tracker.shouldWarn()).toBe(false); // never fires again after markWarned
  });

  it("does not warn when spend is exactly at the threshold (strictly-greater)", () => {
    // Construct a budget whose warnAt equals an exact known spend.
    // One opus turn of 1M cache-read tokens = $cacheReadPerMTok.
    const exactSpend = MODEL_PRICING.opus.cacheReadPerMTok;
    // warnAt = maxUsd * warnFraction => choose maxUsd so warnAt === exactSpend.
    const warnFraction = 0.5;
    const tracker = createBudgetTracker({ maxUsd: exactSpend / warnFraction, warnFraction });
    tracker.add({ cacheReadInputTokens: 1_000_000 }, "opus");
    expect(tracker.spentUsd()).toBeCloseTo(exactSpend, 9);
    expect(tracker.shouldWarn()).toBe(false);
  });

  it("uses DEFAULT_WARN_FRACTION when none is provided", () => {
    expect(DEFAULT_WARN_FRACTION).toBeGreaterThan(0);
    expect(DEFAULT_WARN_FRACTION).toBeLessThan(1);
    const tracker = createBudgetTracker({ maxUsd: 1 });
    // Spend just over DEFAULT_WARN_FRACTION of $1 via opus output tokens.
    const perMTokOutput = MODEL_PRICING.opus.outputPerMTok;
    const tokensForJustOver = Math.ceil(
      ((DEFAULT_WARN_FRACTION + 0.05) * 1_000_000) / perMTokOutput,
    );
    tracker.add({ outputTokens: tokensForJustOver }, "opus");
    expect(tracker.shouldWarn()).toBe(true);
  });
});
