/**
 * A scripted operator for the evals — the missing half of the conversation.
 *
 * Both prompts gate saving behind a conversational turn (system-prompt.ts, "Post-Report
 * Behavior"): present the report, ask "Would you like me to save this report to disk?
 * (yes/no)", then STOP and wait. That is deliberate — consent to save is obtained
 * conversationally rather than in the handler, so the question reaches the operator
 * before the model spends a turn composing a large report.
 *
 * An eval that yields ONE user message therefore cannot pass, however well the agent
 * behaves: it investigates, asks, ends its turn, and nobody answers. Measured — a run
 * with 29 turns, 28 tool calls and 4 correct knowledge reads still reported
 * "FAIL: Agent never called save_report", because there was no operator to say yes.
 *
 * This generator supplies one. It mirrors prod exactly, down to the synchronization
 * primitive: `makeInteractivePrompt` in run-agent.ts awaits a TurnGate that the output
 * loop opens on `stop_reason === "end_turn"`, and so does this.
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { makeUserMessage } from "../agent/run-agent.js";
import type { TurnGate } from "../agent/turn-gate.js";

/**
 * The replies a scripted operator gives after the agent ends a turn.
 *
 * Two, not one: the agent may end a turn before the save question (announcing a plan,
 * say), which would otherwise consume the only answer at the wrong moment. Each is
 * phrased to read correctly either as an answer to "save? (yes/no)" or as a standing
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
