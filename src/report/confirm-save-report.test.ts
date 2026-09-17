/**
 * Tests for the confirm_save_report tool.
 *
 * The tool carries NO report content, and that is its whole point: the operator is
 * asked at the moment the report finishes streaming, before the model spends a
 * second full composition emitting it as save_report's argument. A decline
 * therefore costs nothing at all.
 *
 * The result text is asserted for INSTRUCTION, not wording — it is the only channel
 * that tells the model what to do next, and a bare "no" reads as a hint it may
 * override.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { makeConfirmSaveReportTool } from "./confirm-save-report.js";
import { createSaveConsent } from "./save-consent.js";

/** Runs the tool handler and returns the text block the model receives. */
async function runTool(confirm: () => Promise<boolean>) {
  const consent = createSaveConsent();
  const toolDef = makeConfirmSaveReportTool({ consent, confirm });
  const result = await toolDef.handler({}, {});
  const [block] = result.content as { type: string; text: string }[];
  return { consent, text: block.text };
}

describe("makeConfirmSaveReportTool", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("tool definition", () => {
    it("is named confirm_save_report", () => {
      const consent = createSaveConsent();
      const toolDef = makeConfirmSaveReportTool({ consent, confirm: () => Promise.resolve(true) });
      expect(toolDef.name).toBe("confirm_save_report");
    });

    it("has a description telling the agent to call it before save_report", () => {
      const consent = createSaveConsent();
      const toolDef = makeConfirmSaveReportTool({ consent, confirm: () => Promise.resolve(true) });
      expect(toolDef.description).toContain("save_report");
    });

    it("takes no arguments, so asking costs no report composition", () => {
      const consent = createSaveConsent();
      const toolDef = makeConfirmSaveReportTool({ consent, confirm: () => Promise.resolve(true) });
      expect(Object.keys(toolDef.inputSchema)).toEqual([]);
    });
  });

  describe("handler behavior", () => {
    it("asks the operator exactly once", async () => {
      const confirm = vi.fn().mockResolvedValue(true);
      const consent = createSaveConsent();
      const toolDef = makeConfirmSaveReportTool({ consent, confirm });
      await toolDef.handler({}, {});
      expect(confirm).toHaveBeenCalledOnce();
    });

    it("records a grant the save handler can take", async () => {
      const { consent } = await runTool(() => Promise.resolve(true));
      expect(consent.take()).toBe("granted");
    });

    it("records a decline the save handler can take", async () => {
      const { consent } = await runTool(() => Promise.resolve(false));
      expect(consent.take()).toBe("denied");
    });

    it("tells the model to call save_report after a yes", async () => {
      const { text } = await runTool(() => Promise.resolve(true));
      expect(text).toMatch(/yes/i);
      expect(text).toContain("save_report");
    });

    it("tells the model NOT to save after a no", async () => {
      const { text } = await runTool(() => Promise.resolve(false));
      expect(text).toMatch(/declined|no/i);
      expect(text).toMatch(/do not|don't/i);
    });
  });
});
