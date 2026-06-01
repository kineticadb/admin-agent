/**
 * Tests for the TurnGate synchronization primitive.
 *
 * TurnGate blocks the interactive prompt generator until the agent
 * finishes its turn (end_turn), preventing the "You:" prompt from
 * appearing twice in succession.
 */

import { describe, it, expect } from "vitest";
import { createTurnGate } from "./turn-gate.js";

describe("createTurnGate", () => {
  it("returns a frozen object", () => {
    const gate = createTurnGate();
    expect(Object.isFrozen(gate)).toBe(true);
  });

  it("exposes wait, open, and close methods", () => {
    const gate = createTurnGate();
    expect(typeof gate.wait).toBe("function");
    expect(typeof gate.open).toBe("function");
    expect(typeof gate.close).toBe("function");
  });

  it("starts closed — wait() does not resolve immediately", async () => {
    const gate = createTurnGate();
    let resolved = false;
    const waiting = gate.wait().then(() => {
      resolved = true;
    });

    // Give microtasks a chance to flush
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Clean up: open the gate so the promise resolves
    gate.open();
    await waiting;
    expect(resolved).toBe(true);
  });

  it("open() resolves the wait promise", async () => {
    const gate = createTurnGate();
    const promise = gate.wait();
    gate.open();
    // Should resolve without hanging
    await promise;
  });

  it("open() is idempotent — calling twice does not throw", () => {
    const gate = createTurnGate();
    expect(() => {
      gate.open();
      gate.open();
    }).not.toThrow();
  });

  it("close() after open() makes wait() block again", async () => {
    const gate = createTurnGate();

    // Open then close — should be blocked again
    gate.open();
    gate.close();

    let resolved = false;
    const waiting = gate.wait().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    // Clean up
    gate.open();
    await waiting;
  });

  it("supports full cycle: open → close → open → close", async () => {
    const gate = createTurnGate();

    // Cycle 1: open
    gate.open();
    await gate.wait(); // should resolve immediately

    // Cycle 1: close
    gate.close();

    // Cycle 2: wait should block
    let resolved = false;
    const waiting = gate.wait().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Cycle 2: open
    gate.open();
    await waiting;
    expect(resolved).toBe(true);

    // Cycle 2: close
    gate.close();

    // Verify blocked again
    let resolved2 = false;
    const waiting2 = gate.wait().then(() => {
      resolved2 = true;
    });
    await Promise.resolve();
    expect(resolved2).toBe(false);

    // Clean up
    gate.open();
    await waiting2;
  });

  it("wait() returns a promise", () => {
    const gate = createTurnGate();
    const result = gate.wait();
    expect(result).toBeInstanceOf(Promise);
    // Clean up
    gate.open();
  });

  it("wait() can be called multiple times on same open gate", async () => {
    const gate = createTurnGate();
    gate.open();

    // Both should resolve
    await gate.wait();
    await gate.wait();
  });
});
