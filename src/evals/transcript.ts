/**
 * Transcript readers — pull the few facts an eval needs out of the SDK's message stream.
 *
 * Exists because an eval that cannot tell "the model did the wrong thing" from "the run
 * never happened" reports the second as the first. Measured: with an invalid API key the
 * knowledge-retrieval eval printed `Turns: 1. Cost: $0.0000` and then "FAIL: Agent never
 * called save_report" — indistinguishable from a genuine behavioural regression, and
 * exited 1 (assertion failed) rather than 2 (harness failure). These helpers make the
 * result message, MCP connection failures, and the agent's own words visible so one
 * re-run explains itself.
 *
 * Pure, dependency-free, defensive about shapes: the SDK's message union is wider than
 * what is declared here and transcripts are untyped JSON at the edges.
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** One tool invocation from the transcript, in call order. */
export type ToolCall = {
  readonly name: string;
  readonly input: Record<string, unknown>;
};

/** What a run's terminating result message says. */
export type RunOutcome = {
  /** SDK result subtype: "success", "error_during_execution", "error_max_turns", … */
  readonly subtype: string;
  readonly isError: boolean;
  readonly numTurns: number;
  readonly costUsd: number;
  /** The result text, when the SDK supplied one (usually an error description). */
  readonly detail: string;
};

/** Render an untyped field as a label, without String()-ing a non-primitive. */
function label(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Narrow an unknown message field to a record without trusting its shape. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Collect every tool_use block from one assistant message, in order. */
export function collectToolCalls(message: SDKMessage): readonly ToolCall[] {
  if (message.type !== "assistant") return [];
  const content = asRecord((message as { message?: unknown }).message).content;
  if (!Array.isArray(content)) return [];
  return content
    .map(asRecord)
    .filter((block) => block.type === "tool_use" && typeof block.name === "string")
    .map((block) => ({
      name: block.name as string,
      input: asRecord(block.input),
    }));
}

/** The plain text of one assistant message, or "" when it carried none. */
export function assistantText(message: SDKMessage): string {
  if (message.type !== "assistant") return "";
  const content = asRecord((message as { message?: unknown }).message).content;
  if (!Array.isArray(content)) return "";
  return content
    .map(asRecord)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

/** Cache-read tokens reported on one assistant message (0 when absent). */
export function cacheReadTokens(message: SDKMessage): number {
  if (message.type !== "assistant") return 0;
  const usage = asRecord(asRecord((message as { message?: unknown }).message).usage);
  const tokens = usage.cache_read_input_tokens;
  return typeof tokens === "number" ? tokens : 0;
}

/**
 * Report OUR MCP server if it did not reach "connected" in the init message.
 *
 * A silent MCP failure is the one fault that looks exactly like a model regression:
 * the agent simply has no tools, answers once in prose, and the run ends.
 *
 * `serverName` is required, not optional, and that is the whole point. The init message
 * also lists the OPERATOR's ambient claude.ai connectors — Gmail, Slack, Stripe and the
 * rest — which sit at `needs-auth` as their normal resting state and have nothing to do
 * with the eval. Reporting those turned a healthy run (34 tool calls, 2 turn groups, 4
 * correct knowledge reads) into a HARNESS FAILURE: a diagnostic added to prevent false
 * conclusions producing one. `run-agent.ts` filters on its own server name for exactly
 * this reason; this is that filter.
 */
export function mcpInitFailures(message: SDKMessage, serverName: string): readonly string[] {
  if (message.type !== "system") return [];
  const msg = asRecord(message);
  if (msg.subtype !== "init") return [];
  const servers = msg.mcp_servers;
  if (!Array.isArray(servers)) return [];
  return servers
    .map(asRecord)
    .filter((s) => s.name === serverName && s.status !== "connected")
    .map((s) => `${label(s.name, "unknown")} (${label(s.status, "unknown status")})`);
}

/** True when the agent finished its turn and is waiting on the operator. */
export function isEndTurn(message: SDKMessage): boolean {
  if (message.type !== "assistant") return false;
  const inner = asRecord((message as { message?: unknown }).message);
  return inner.stop_reason === "end_turn";
}

/** Read a result message. Returns undefined for any other message. */
export function readOutcome(message: SDKMessage): RunOutcome | undefined {
  if (message.type !== "result") return undefined;
  const msg = asRecord(message);
  const subtype = typeof msg.subtype === "string" ? msg.subtype : "unknown";
  return {
    subtype,
    // Trust the SDK's own flag when present; otherwise anything but "success" is an error.
    isError: typeof msg.is_error === "boolean" ? msg.is_error : subtype !== "success",
    numTurns: typeof msg.num_turns === "number" ? msg.num_turns : 0,
    costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0,
    detail: typeof msg.result === "string" ? msg.result : "",
  };
}

/** Everything an eval needs from one agent run. */
export type TranscriptSummary = {
  readonly calls: readonly ToolCall[];
  readonly initFailures: readonly string[];
  readonly cacheReads: number;
  /** The agent's last prose — what it said when it stopped. */
  readonly lastText: string;
  /** The FINAL result message; undefined if the stream carried none. */
  readonly outcome: RunOutcome | undefined;
  /** How many result messages arrived. >1 means the conversation had several turns. */
  readonly resultCount: number;
  /**
   * Turns and cost summed across ALL result messages.
   *
   * `outcome` carries only the LAST turn group's figures, which understates a
   * multi-turn conversation badly: a run that investigated for 30 turns and then saved
   * in 4 reported "Turns: 4".
   */
  readonly totalTurns: number;
  readonly totalCostUsd: number;
};

/**
 * Consume an agent run to completion, collecting what the assertions need.
 *
 * **It deliberately does NOT stop at the first `result`.** A result message arrives at
 * the end of each agent turn, not once per session — `run-agent.ts` handles one and
 * keeps iterating, opening its turn gate so the prompt generator "can exit cleanly".
 * An eval that breaks there abandons the stream exactly when the agent has asked its
 * save question, so the operator's answer is yielded into a stream nobody is reading and
 * the report is never written. Measured twice: 29 turns then 30, both reporting
 * "Agent never called save_report" for a run that had done all the work.
 *
 * The loop ends when the stream ends, which happens once the prompt generator returns.
 * That generator must therefore be bounded — see scripted-operator.ts.
 *
 * @param onTurnEnd called whenever the agent yields the floor (an `end_turn` assistant
 *   message, or a result), so the caller can release its prompt generator. Mirrors what
 *   run-agent.ts does with its TurnGate.
 */
export async function consumeTranscript(
  stream: AsyncIterable<SDKMessage>,
  onTurnEnd: () => void,
  serverName: string,
): Promise<TranscriptSummary> {
  const calls: ToolCall[] = [];
  const initFailures: string[] = [];
  let cacheReads = 0;
  let lastText = "";
  let outcome: RunOutcome | undefined;
  let resultCount = 0;
  let totalTurns = 0;
  let totalCostUsd = 0;

  for await (const message of stream) {
    calls.push(...collectToolCalls(message));
    initFailures.push(...mcpInitFailures(message, serverName));
    cacheReads += cacheReadTokens(message);
    lastText = assistantText(message) || lastText;

    const result = readOutcome(message);
    if (result) {
      outcome = result;
      resultCount += 1;
      totalTurns += result.numTurns;
      totalCostUsd += result.costUsd;
    }
    if (result || isEndTurn(message)) onTurnEnd();
  }

  return {
    calls,
    initFailures,
    cacheReads,
    lastText,
    outcome,
    resultCount,
    totalTurns,
    totalCostUsd,
  };
}

/**
 * Explain why a run produced nothing to assert on, or "" when it looks assertable.
 *
 * The caller uses a non-empty return to exit 2 (harness failure) instead of 1
 * (assertion failure) — the distinction the invalid-key run collapsed.
 */
export function diagnoseEmptyRun(
  outcome: RunOutcome | undefined,
  toolCalls: readonly ToolCall[],
  initFailures: readonly string[],
): string {
  if (!outcome) return "The agent stream ended without a result message.";
  if (outcome.isError) {
    return (
      `The run FAILED before it could be assessed: ${outcome.subtype}` +
      (outcome.detail ? ` — ${outcome.detail}` : "") +
      ". This is a harness or API failure, not a model regression."
    );
  }
  if (initFailures.length > 0) {
    return (
      `MCP server did not connect: ${initFailures.join(", ")}. The agent had no tools, ` +
      `so nothing about its behaviour can be concluded.`
    );
  }
  if (toolCalls.length === 0 && outcome.costUsd === 0 && outcome.numTurns <= 1) {
    // Reached only when nothing was called at all, so the last result's own figures
    // are the whole run's — no need for the summed ones here.
    return (
      `The agent made no tool calls, took ${outcome.numTurns} turn(s) and was billed $0.00 — ` +
      `the run almost certainly never reached the model. Check ANTHROPIC_API_KEY and network access.`
    );
  }
  return "";
}
