/**
 * System-prompt token-budget tripwire.
 *
 * The agent assembles its entire knowledge corpus (all playbooks + all references +
 * SQL examples + tool catalog) into a single system prompt at startup
 * (see system-prompt.ts). Today that is cheap, but it grows linearly as the corpus
 * grows. This module makes the cost *visible* — a tripwire that fires before the
 * prompt gets expensive, rather than discovering it via a surprise API bill.
 *
 * Exports:
 *   estimateTokens(text)               — dependency-free token estimate (chars / 4, rounded up)
 *   checkPromptBudget(prompt, opts?)   — measure a prompt and flag it against a threshold
 *   DEFAULT_PROMPT_BUDGET_TOKENS       — default warn threshold
 *
 * Design:
 *   - Pure functions, no I/O — the caller decides whether/how to log (keeps this testable)
 *   - Immutable readonly result type
 *   - Never throws (degrades to 0 on falsy input)
 *
 * Token estimate is deliberately a heuristic, not a real tokenizer: a tripwire needs to be
 * *present*, not *precise*. If exact counts ever matter, swap estimateTokens() for a
 * tokenizer or the API count_tokens endpoint behind the same signature — callers won't change.
 */

/** Average characters per token — the standard rough estimate for English/code/markdown. */
const CHARS_PER_TOKEN = 4;

/**
 * Default threshold (in estimated tokens) above which the assembled system prompt is
 * considered expensive enough to warn about. Chosen as a tripwire, not a hard limit.
 *
 * Raised 15_000 → 20_000 (2026-06-03). The measured baseline is ~13,422 tokens, and the
 * system prompt is *cached* by the Agent SDK (written once at startup, re-read on every
 * turn — see the cache-token telemetry in run-agent.ts), so the marginal cost of the
 * corpus is near-zero. The earlier 15_000 left only ~10% headroom and fired as a false
 * alarm well before any real cost concern. 20_000 keeps the tripwire meaningful (it still
 * catches roughly a 50% corpus growth) without crying wolf.
 */
export const DEFAULT_PROMPT_BUDGET_TOKENS = 20_000;

/** Result of measuring a prompt against a budget threshold. Immutable. */
export type BudgetReport = {
  /** Estimated token count. */
  readonly tokens: number;
  /** Raw character count of the prompt. */
  readonly chars: number;
  /** The threshold the estimate was compared against. */
  readonly threshold: number;
  /** True when tokens strictly exceed the threshold. */
  readonly overBudget: boolean;
};

/**
 * Estimate the token count of a string using a fixed chars-per-token heuristic.
 * Rounds up so any non-empty input estimates at least one token. Never throws.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Measure a prompt and report whether it exceeds the token budget.
 *
 * @param prompt - the assembled prompt string to measure
 * @param opts.warnAtTokens - override the default threshold (defaults to
 *   DEFAULT_PROMPT_BUDGET_TOKENS). The comparison is strictly-greater: a prompt
 *   exactly at the threshold is NOT flagged.
 */
export function checkPromptBudget(
  prompt: string,
  opts?: { readonly warnAtTokens?: number },
): BudgetReport {
  const threshold = opts?.warnAtTokens ?? DEFAULT_PROMPT_BUDGET_TOKENS;
  const tokens = estimateTokens(prompt);
  return {
    tokens,
    chars: prompt ? prompt.length : 0,
    threshold,
    overBudget: tokens > threshold,
  };
}
