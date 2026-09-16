/**
 * End-to-end test of the EVAL HARNESS itself, with no API.
 *
 * Written after three consecutive live eval runs failed on harness bugs rather than
 * model behaviour — each one costing ~$0.29 and several minutes, and each diagnosed by
 * inspection rather than by test. The harness's job is to survive one specific
 * conversation shape, and that shape is fully simulatable:
 *
 *     operator states the issue
 *   → agent investigates (tool calls)
 *   → agent presents the report and ASKS whether to save, then ends its turn
 *   → operator answers
 *   → agent calls save_report
 *   → conversation ends
 *
 * The two halves that must cooperate are `scriptedOperator` (yields, then waits on a
 * TurnGate) and `consumeTranscript` (reads the stream, opens that gate). Both bugs lived
 * exactly in that seam, and neither unit test caught them because each half was correct
 * in isolation:
 *
 *   1. nothing opened the gate  → the operator waits forever (this test HANGS)
 *   2. the loop broke on the first `result` → the stream is abandoned the moment the
 *      agent asks about saving (this test finds no save_report call)
 *
 * If this test passes, a live run is an informed prediction rather than another guess.
 */

import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { scriptedOperator, SAVE_REPLIES } from "./scripted-operator.js";
import { consumeTranscript } from "./transcript.js";
import { createTurnGate } from "../agent/turn-gate.js";

// --- message builders, shaped like the SDK's --------------------------------

const toolUse = (name: string): SDKMessage =>
  ({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input: {} }], stop_reason: "tool_use" },
  }) as unknown as SDKMessage;

/** The agent presenting its report and asking the save question, then yielding the floor. */
const asksAndWaits = (text: string): SDKMessage =>
  ({
    type: "assistant",
    message: { content: [{ type: "text", text }], stop_reason: "end_turn" },
  }) as unknown as SDKMessage;

const result = (numTurns: number): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: numTurns,
    total_cost_usd: 0.1,
  }) as unknown as SDKMessage;

const SAVE_QUESTION = "Would you like me to save this report to disk? (yes/no)";

describe("eval harness — the full conversation", () => {
  it("completes the save handshake the system prompts require", async () => {
    const gate = createTurnGate();
    let saved = false;
    const operator = scriptedOperator("queries are slow", SAVE_REPLIES, gate, () => saved);
    const operatorSaw: string[] = [];

    /**
     * Stands in for the SDK: pulls from the operator generator exactly where the real
     * agent would, and emits the message shapes the real one emits.
     */
    async function* fakeAgentRun(): AsyncGenerator<SDKMessage> {
      const issue = await operator.next();
      expect(issue.done).toBe(false);
      operatorSaw.push("issue");

      // Round 1-3: investigate.
      yield toolUse("kinetica_health_check");
      yield toolUse("kinetica_knowledge_read");

      // Post-Report Behavior: present, ask, STOP. The floor passes to the operator.
      yield asksAndWaits(SAVE_QUESTION);
      yield result(20);

      // Blocks until the harness opened the gate. Bug #1 deadlocks here.
      const answer = await operator.next();
      expect(answer.done).toBe(false);
      operatorSaw.push("answer");

      yield toolUse("save_report");
      saved = true;
      yield result(22);

      // The operator has nothing left to say and ends the conversation.
      const after = await operator.next();
      expect(after.done).toBe(true);
    }

    const summary = await consumeTranscript(
      fakeAgentRun(),
      () => {
        gate.open();
      },
      "kinetica-diagnostics",
    );

    // Bug #2 fails here: the stream was abandoned before save_report was ever emitted.
    expect(summary.calls.map((c) => c.name)).toContain("save_report");
    // The operator spoke twice: the issue, then the answer to the save question.
    expect(operatorSaw).toEqual(["issue", "answer"]);
    // Two result messages — the signal `Turn groups: N` surfaces in the eval output.
    expect(summary.resultCount).toBe(2);
    expect(summary.outcome?.numTurns).toBe(22);
    expect(summary.lastText).toBe(SAVE_QUESTION);
  });

  it("ends cleanly when the agent saves without being asked twice", async () => {
    // The agent may save in its first turn (e.g. a budget-pressure checkpoint). The
    // operator must then stop rather than buying another billed turn.
    const gate = createTurnGate();
    let saved = false;
    const operator = scriptedOperator("the issue", SAVE_REPLIES, gate, () => saved);
    let extraReplies = 0;

    async function* fakeAgentRun(): AsyncGenerator<SDKMessage> {
      await operator.next();
      yield toolUse("save_report");
      saved = true;
      yield result(5);
      const after = await operator.next();
      if (!after.done) extraReplies += 1;
    }

    const summary = await consumeTranscript(
      fakeAgentRun(),
      () => {
        gate.open();
      },
      "kinetica-diagnostics",
    );
    expect(summary.calls.map((c) => c.name)).toContain("save_report");
    expect(extraReplies).toBe(0);
  });

  it("does not hang when the agent never yields the floor", async () => {
    // A run that errors out mid-investigation must still terminate the harness.
    const gate = createTurnGate();
    const operator = scriptedOperator("the issue", SAVE_REPLIES, gate, () => false);

    async function* fakeAgentRun(): AsyncGenerator<SDKMessage> {
      await operator.next();
      yield toolUse("kinetica_health_check");
      // Stream simply ends — no end_turn, no result.
    }

    const summary = await consumeTranscript(
      fakeAgentRun(),
      () => {
        gate.open();
      },
      "kinetica-diagnostics",
    );
    expect(summary.outcome).toBeUndefined();
    expect(summary.resultCount).toBe(0);
  });
});
