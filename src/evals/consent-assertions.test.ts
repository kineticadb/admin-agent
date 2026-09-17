/**
 * Tests for the save-consent assertion.
 *
 * The partial-checkpoint cases are the ones worth reading: an unconfirmed save is
 * CORRECT behaviour when it carries `partial: true`, so an assertion that ignored the
 * flag would fail the exact budget-pressure path both prompts mandate.
 */
import { describe, it, expect } from "vitest";

import { askedBeforeSave, validateSaveConsent } from "./consent-assertions.js";
import type { ToolCall } from "./transcript.js";

const call = (name: string, input: Record<string, unknown> = {}): ToolCall => ({ name, input });

const ASK = call("confirm_save_report");
const SAVE = call("save_report", { content: "# Report" });
const PARTIAL = call("save_report", { content: "# Partial", partial: true });
const OTHER = call("kinetica_health_check");

describe("askedBeforeSave", () => {
  it("is true when the ask precedes the save", () => {
    expect(askedBeforeSave([OTHER, ASK, SAVE])).toBe(true);
  });

  it("is false when the agent saved without ever asking", () => {
    expect(askedBeforeSave([OTHER, SAVE])).toBe(false);
  });

  it("is false when the ask came after the save", () => {
    expect(askedBeforeSave([SAVE, ASK])).toBe(false);
  });

  it("is undefined when nothing was saved — there was no consent to give", () => {
    expect(askedBeforeSave([OTHER, ASK])).toBeUndefined();
  });

  it("is undefined when the only save was a partial checkpoint", () => {
    // A partial checkpoint under budget pressure is prescribed to skip confirmation.
    expect(askedBeforeSave([OTHER, PARTIAL])).toBeUndefined();
  });

  it("judges the first FULL save, not a partial checkpoint that preceded it", () => {
    expect(askedBeforeSave([PARTIAL, ASK, SAVE])).toBe(true);
    expect(askedBeforeSave([PARTIAL, SAVE])).toBe(false);
  });

  it("reads through the MCP name prefix the SDK adds", () => {
    const qualify = (c: ToolCall): ToolCall => ({
      ...c,
      name: `mcp__kinetica-diagnostics__${c.name}`,
    });
    expect(askedBeforeSave([qualify(ASK), qualify(SAVE)])).toBe(true);
  });
});

describe("validateSaveConsent", () => {
  it("passes when the ask preceded the save", () => {
    expect(validateSaveConsent([ASK, SAVE])).toEqual({ passed: true, errors: [] });
  });

  it("fails, naming both tools, when the save was unconfirmed", () => {
    const result = validateSaveConsent([SAVE]);
    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("confirm_save_report");
    expect(result.errors[0]).toContain("save_report");
  });

  it("stays silent when no full save happened — another assertion owns that", () => {
    // A missing report is already reported as its own failure; repeating it here would
    // turn one fault into two errors.
    expect(validateSaveConsent([OTHER]).passed).toBe(true);
    expect(validateSaveConsent([PARTIAL]).passed).toBe(true);
  });
});
