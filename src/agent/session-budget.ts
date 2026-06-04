/**
 * Session cost tracking and budget resolution.
 *
 * The agent caps per-session spend via the SDK's `maxBudgetUsd`. The SDK knows the
 * true cost and enforces the cap accurately — but it only reports the dollar figure
 * (`total_cost_usd`) on the *final* result message. Mid-session, each assistant turn
 * exposes only token `usage`. So to warn the operator *before* the hard cap fires,
 * we must estimate running cost from token counts.
 *
 * This module is the estimator. It is deliberately a tripwire, not an accountant —
 * same philosophy as prompt-budget.ts: a warning needs to be *present*, not *precise*.
 * The SDK's `maxBudgetUsd` remains the source of truth for the actual cutoff.
 *
 * Exports:
 *   MODEL_PRICING            — per-model, per-MTok price table (estimate only)
 *   DEFAULT_MAX_BUDGET_USD   — default per-session budget when not overridden
 *   DEFAULT_WARN_FRACTION    — fraction of the budget at which to warn (0.8)
 *   estimateTurnCostUsd()    — price one assistant turn's token usage
 *   resolveMaxBudgetUsd()    — resolve the budget from flag > env > default
 *   createBudgetTracker()    — accumulate spend and fire a one-shot warning
 *
 * Design:
 *   - Pure functions + a closure-based factory (no I/O — callers decide how to log)
 *   - Never throws (missing/invalid token counts degrade to 0)
 *   - Does not mutate any argument passed in
 */

import type { AgentModel } from "./run-agent.js";

/** Default maximum budget in USD per session when neither flag nor env overrides it. */
export const DEFAULT_MAX_BUDGET_USD = 5.0;

/** Fraction of the budget at which the running-cost warning fires. */
export const DEFAULT_WARN_FRACTION = 0.8;

/** Environment variable that overrides the default budget (lower precedence than --max-budget). */
const BUDGET_ENV_VAR = "ADMIN_AGENT_MAX_BUDGET";

/** Per-million-token prices for a single model, in USD. */
export type ModelPrice = {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;
  readonly cacheCreationPerMTok: number;
};

/**
 * Per-model price table (USD per million tokens). These are ESTIMATES used only to
 * drive the early-warning tripwire — the SDK's `maxBudgetUsd` enforces the real cap
 * using true cost. Update these when Anthropic pricing changes; exactness is not
 * required for the warning to be useful.
 *
 * Anthropic's standard ratios are encoded here: cache *write* ≈ 1.25× base input,
 * cache *read* ≈ 0.1× base input. Keyed over AgentModel so adding a model to
 * SUPPORTED_MODELS without a price is a typecheck error (no silent $0 pricing).
 *
 * NOTE: if the SDK fails over to the fallback model (haiku) mid-session, spend is
 * still estimated with the primary model's rates — an acceptable tripwire imprecision.
 */
export const MODEL_PRICING: Record<AgentModel, ModelPrice> = {
  sonnet: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheCreationPerMTok: 3.75 },
  haiku: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheCreationPerMTok: 1.25 },
  opus: { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheCreationPerMTok: 18.75 },
};

/**
 * Normalized token usage for one assistant turn. Fields mirror the SDK's usage object
 * but use camelCase and tolerate null/undefined. Use `fromSdkUsage()` to convert the
 * SDK's snake_case `BetaUsage` into this shape, keeping this module SDK-agnostic and testable.
 */
export type TokenUsage = {
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cacheReadInputTokens?: number | null;
  readonly cacheCreationInputTokens?: number | null;
};

/**
 * Normalize the SDK's snake_case assistant-message usage (`BetaUsage`, which resolves to
 * `any` at the call site) into the camelCase `TokenUsage` shape. Pure, never throws — this
 * is the single place that knows the SDK's field names, so the message loop stays clean and
 * this glue is unit-testable.
 */
export function fromSdkUsage(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadInputTokens: u.cache_read_input_tokens,
    cacheCreationInputTokens: u.cache_creation_input_tokens,
  };
}

/** Coerce a possibly-missing token count to a safe non-negative number. */
function safeCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * True for a usable positive, finite budget value. Exported so the CLI's --max-budget
 * validator and this module's env/default resolver share one definition of "valid budget"
 * and can never drift.
 */
export function isValidBudget(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Estimate the USD cost of one assistant turn from its token usage.
 * Returns 0 for missing usage; never throws. Input, output, cache-read, and
 * cache-creation tokens are priced separately (they are distinct usage classes,
 * so summing them does not double-count).
 */
export function estimateTurnCostUsd(
  usage: TokenUsage | null | undefined,
  model: AgentModel,
): number {
  if (!usage) return 0;
  const price = MODEL_PRICING[model];
  const input = safeCount(usage.inputTokens);
  const output = safeCount(usage.outputTokens);
  const cacheRead = safeCount(usage.cacheReadInputTokens);
  const cacheCreation = safeCount(usage.cacheCreationInputTokens);
  return (
    (input * price.inputPerMTok +
      output * price.outputPerMTok +
      cacheRead * price.cacheReadPerMTok +
      cacheCreation * price.cacheCreationPerMTok) /
    1_000_000
  );
}

/**
 * Resolve the per-session budget in USD.
 *
 * Precedence: a valid `flagValue` (from --max-budget) wins, then a valid
 * `ADMIN_AGENT_MAX_BUDGET` env var, then DEFAULT_MAX_BUDGET_USD. Invalid values at
 * any level (≤ 0, non-finite, non-numeric) are ignored so a bad env var degrades
 * gracefully to the default rather than crashing the session.
 *
 * @param flagValue - the already-parsed --max-budget value, or undefined
 * @param env - environment to read (defaults to process.env; injectable for tests)
 */
export function resolveMaxBudgetUsd(
  flagValue?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (isValidBudget(flagValue)) return flagValue;
  const raw = env[BUDGET_ENV_VAR];
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (isValidBudget(parsed)) return parsed;
  }
  return DEFAULT_MAX_BUDGET_USD;
}

/** Accumulates estimated session spend and fires a one-shot "approaching budget" warning. */
export type BudgetTracker = {
  /** Add one assistant turn's usage to the running estimate. */
  add(usage: TokenUsage | null | undefined, model: AgentModel): void;
  /** The running estimated spend in USD. */
  spentUsd(): number;
  /** True once spend strictly exceeds the warn threshold AND the warning has not yet been acknowledged. */
  shouldWarn(): boolean;
  /** Mark the warning as emitted so shouldWarn() never fires again. */
  markWarned(): void;
};

/**
 * Create a budget tracker.
 *
 * The warning fires when estimated spend *strictly exceeds* `warnFraction * maxUsd`
 * (strictly-greater matches prompt-budget.ts: a value exactly at the threshold is not
 * flagged). `shouldWarn()` returns false after `markWarned()`, so callers get a single
 * warning without tracking state themselves.
 */
export function createBudgetTracker(opts: {
  readonly maxUsd: number;
  readonly warnFraction?: number;
}): BudgetTracker {
  const warnFraction = opts.warnFraction ?? DEFAULT_WARN_FRACTION;
  const warnAt = opts.maxUsd * warnFraction;
  // Closure-local accumulator state — the codebase's standard factory pattern
  // (createTurnGate, createSession). No external object is mutated.
  let spent = 0;
  let warned = false;
  return {
    add(usage, model) {
      spent += estimateTurnCostUsd(usage, model);
    },
    spentUsd() {
      return spent;
    },
    shouldWarn() {
      return !warned && spent > warnAt;
    },
    markWarned() {
      warned = true;
    },
  };
}
