/**
 * A scripted operator for the evals — the missing half of the conversation.
 *
 * Saving used to require one: both prompts told the agent to ask "save this report to
 * disk? (yes/no)", end its turn, and wait. An eval that yields ONE user message could
 * not pass, however well the agent behaved — measured, a run with 29 turns, 28 tool
 * calls and 4 correct knowledge reads still reported "FAIL: Agent never called
 * save_report", because nobody was there to say yes.
 *
 * Since 2026-09-16 the question is a Y/n widget the agent raises MID-TURN via
 * confirm_save_report, and the evals register that tool with an auto-approving
 * operator. The save therefore lands before the first end_turn, `isDone()` fires, and
 * this generator usually returns without spending a reply.
 *
 * It is kept because the agent may still end a turn for its own reasons before the
 * report exists — announcing a plan, or asking a clarifying question — and an
 * unanswered turn stalls the run just as it did before. It mirrors prod exactly, down
 * to the synchronization primitive: `makeInteractivePrompt` in run-agent.ts awaits a
 * TurnGate that the output loop opens on `stop_reason === "end_turn"`, and so does this.
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { makeUserMessage } from "../agent/run-agent.js";
import type { TurnGate } from "../agent/turn-gate.js";

/**
 * The replies a scripted operator gives after the agent ends a turn.
 *
 * Now a fallback rather than the main path: consent arrives through the
 * confirm_save_report widget mid-turn, so these are spent only when the agent ends a
 * turn before the report exists. Each is phrased to read correctly as a standing
 * instruction, so a mistimed one is harmless.
 */
export const SAVE_REPLIES: readonly string[] = [
  "Yes — please save the report to disk.",
  "Yes, save the report now.",
];

/**
 * Yield the issue, then answer each time the agent ends its turn.
 *
 * @param issue     the operator's opening message
 * @param replies   what to say on each subsequent turn, in order
 * @param gate      opened by the eval's output loop on end_turn
 * @param isDone    stop early once there is nothing left to wait for (the report was
 *                  captured) — otherwise a spare reply buys another billed turn of
 *                  work the eval does not assert on
 */
export async function* scriptedOperator(
  issue: string,
  replies: readonly string[],
  gate: TurnGate,
  isDone: () => boolean,
): AsyncGenerator<SDKUserMessage> {
  yield makeUserMessage(issue);

  for (const reply of replies) {
    await gate.wait();
    if (isDone()) return;
    gate.close();
    yield makeUserMessage(reply);
  }
}
