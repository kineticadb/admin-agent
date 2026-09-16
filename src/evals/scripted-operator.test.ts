/**
 * Tests for the scripted operator. Covered by the fast suite because the bug it fixes
 * was invisible to every unit test: the eval harness, not the agent, was incomplete.
 */

import { describe, it, expect } from "vitest";
import { scriptedOperator, SAVE_REPLIES } from "./scripted-operator.js";
import { createTurnGate } from "../agent/turn-gate.js";

/** Read the text out of the SDKUserMessage envelope. */
const textOf = (msg: { message: { content: unknown } }): string => {
  const content = msg.message.content;
  return typeof content === "string" ? content : JSON.stringify(content);
};

describe("scriptedOperator", () => {
  it("yields the issue first, without waiting on the gate", async () => {
    const gate = createTurnGate(); // starts CLOSED — a wait here would deadlock
    const gen = scriptedOperator("the issue", SAVE_REPLIES, gate, () => false);
    const first = await gen.next();
    expect(textOf(first.value as never)).toContain("the issue");
  });

  it("answers after the agent ends its turn", async () => {
    const gate = createTurnGate();
    const gen = scriptedOperator("the issue", ["yes please"], gate, () => false);
    await gen.next();

    const pending = gen.next();
    gate.open(); // the output loop's end_turn signal
    const second = await pending;
    expect(textOf(second.value as never)).toContain("yes please");
  });

  it("stops as soon as the report has been captured", async () => {
    const gate = createTurnGate();
    const gen = scriptedOperator("the issue", ["yes please"], gate, () => true);
    await gen.next();

    const pending = gen.next();
    gate.open();
    // A spare reply would buy another billed turn the eval never asserts on.
    expect((await pending).done).toBe(true);
  });

  it("ends the conversation once its replies are exhausted", async () => {
    const gate = createTurnGate();
    const gen = scriptedOperator("the issue", ["only one"], gate, () => false);
    await gen.next();
    const p1 = gen.next();
    gate.open();
    await p1;

    const p2 = gen.next();
    gate.open();
    expect((await p2).done).toBe(true);
  });

  it("carries two replies, so an early end_turn does not consume the only answer", () => {
    expect(SAVE_REPLIES.length).toBeGreaterThanOrEqual(2);
    for (const reply of SAVE_REPLIES) expect(reply.toLowerCase()).toContain("save");
  });
});
