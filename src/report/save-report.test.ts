/**
 * Tests for the save_report MCP tool factory.
 *
 * Verifies:
 * - grantedTool() returns a valid MCP tool definition with name "save_report"
 * - formatTimestamp() produces YYYY-MM-DD-HHmmss in UTC
 * - Reports are saved to reports/ directory with timestamped filenames
 * - Credential scrubbing is applied before writing
 * - Partial reports include the (PARTIAL -- investigation interrupted) marker
 * - Directory is created automatically (recursive: true)
 * - Tool handler returns filepath confirmation message
 * - The write is gated on operator consent, which confirm_save_report records
 *
 * The consent block is the load-bearing one. Consent used to be a prompt rule the
 * model was trusted to follow; it is now a token the handler takes, so these tests
 * assert the property that matters -- no grant, no file -- rather than the wording
 * of any instruction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSaveReportTool, formatTimestamp } from "./save-report.js";

// Mock node:fs/promises to avoid real file I/O
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import * as fsPromises from "node:fs/promises";

import { createSaveConsent } from "./save-consent.js";

/** The normal path: confirm_save_report already recorded the operator's yes. */
function grantedTool() {
  const consent = createSaveConsent();
  consent.record(true);
  return makeSaveReportTool({ consent, confirm: () => Promise.resolve(true) });
}

describe("formatTimestamp", () => {
  it("formats a UTC date to YYYY-MM-DD-HHmmss", () => {
    // 2024-06-15T14:30:45.000Z
    const date = new Date("2024-06-15T14:30:45.000Z");
    const result = formatTimestamp(date);
    expect(result).toBe("2024-06-15-143045");
  });

  it("pads single-digit months, days, hours, minutes, seconds", () => {
    // 2024-01-05T09:05:03.000Z
    const date = new Date("2024-01-05T09:05:03.000Z");
    const result = formatTimestamp(date);
    expect(result).toBe("2024-01-05-090503");
  });

  it("uses UTC time (not local time)", () => {
    // A date at midnight UTC
    const date = new Date("2024-12-31T00:00:00.000Z");
    const result = formatTimestamp(date);
    expect(result).toBe("2024-12-31-000000");
  });

  it("returns a string in the format YYYY-MM-DD-HHmmss", () => {
    const date = new Date("2024-03-09T12:34:56.000Z");
    const result = formatTimestamp(date);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}$/);
  });
});

describe("makeSaveReportTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("tool definition", () => {
    it("returns an object with name 'save_report'", () => {
      const toolDef = grantedTool();
      expect(toolDef.name).toBe("save_report");
    });

    it("returns a tool definition with a description", () => {
      const toolDef = grantedTool();
      expect(typeof toolDef.description).toBe("string");
      expect(toolDef.description.length).toBeGreaterThan(0);
    });
  });

  describe("handler behavior", () => {
    it("creates reports/ directory with recursive:true", async () => {
      const toolDef = grantedTool();
      await toolDef.handler({ content: "## Report\nSome content", partial: undefined }, {});

      const mkdirMock = vi.mocked(fsPromises.mkdir);
      expect(mkdirMock).toHaveBeenCalledOnce();
      const [, options] = mkdirMock.mock.calls[0];
      expect(options).toEqual({ recursive: true });
    });

    it("writes file with kinetica-diag-YYYY-MM-DD-HHmmss.md filename", async () => {
      const toolDef = grantedTool();
      await toolDef.handler({ content: "## Report\nSome content", partial: undefined }, {});

      const writeFileMock = vi.mocked(fsPromises.writeFile);
      expect(writeFileMock).toHaveBeenCalledOnce();
      const [filepath] = writeFileMock.mock.calls[0];
      expect(typeof filepath).toBe("string");
      expect(filepath as string).toMatch(/kinetica-diag-\d{4}-\d{2}-\d{2}-\d{6}\.md$/);
    });

    it("writes file to reports/ subdirectory", async () => {
      const toolDef = grantedTool();
      await toolDef.handler({ content: "## Report\nSome content", partial: undefined }, {});

      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const [filepath] = writeFileMock.mock.calls[0];
      expect(filepath as string).toContain("/reports/");
    });

    it("scrubs credentials from content before writing", async () => {
      const toolDef = grantedTool();
      const sensitiveContent = "Connected to https://kinetica.example.com:9191/api\n## Summary";
      await toolDef.handler({ content: sensitiveContent, partial: undefined }, {});

      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const [, writtenContent] = writeFileMock.mock.calls[0];
      expect(writtenContent as string).not.toContain("kinetica.example.com");
      expect(writtenContent as string).toContain("[REDACTED]");
      expect(writtenContent as string).toContain("## Summary");
    });

    it("writes UTF-8 encoded files", async () => {
      const toolDef = grantedTool();
      await toolDef.handler({ content: "## Report", partial: undefined }, {});

      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const [, , encoding] = writeFileMock.mock.calls[0];
      expect(encoding).toBe("utf-8");
    });

    it("returns filepath in content text", async () => {
      const toolDef = grantedTool();
      const result = await toolDef.handler({ content: "## Report", partial: undefined }, {});

      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringMatching(/^Report saved: .+\.md$/),
      });
    });

    it("prepends PARTIAL marker when partial=true", async () => {
      const toolDef = grantedTool();
      await toolDef.handler({ content: "## Partial Report", partial: true }, {});

      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const [, writtenContent] = writeFileMock.mock.calls[0];
      expect(writtenContent as string).toContain("(PARTIAL -- investigation interrupted)");
      expect(writtenContent as string).toMatch(/^\(PARTIAL -- investigation interrupted\)\n\n/);
    });

    it("does not prepend PARTIAL marker when partial=false", async () => {
      const toolDef = grantedTool();
      await toolDef.handler({ content: "## Full Report", partial: false }, {});

      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const [, writtenContent] = writeFileMock.mock.calls[0];
      expect(writtenContent as string).not.toContain("(PARTIAL -- investigation interrupted)");
    });

    it("does not prepend PARTIAL marker when partial is omitted", async () => {
      const toolDef = grantedTool();
      await toolDef.handler({ content: "## Full Report", partial: undefined }, {});

      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const [, writtenContent] = writeFileMock.mock.calls[0];
      expect(writtenContent as string).not.toContain("(PARTIAL -- investigation interrupted)");
    });

    it("applies credential scrubbing AFTER prepending partial marker", async () => {
      const toolDef = grantedTool();
      const sensitiveContent = "https://kinetica.example.com:9191 - Evidence";
      await toolDef.handler({ content: sensitiveContent, partial: true }, {});

      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const [, writtenContent] = writeFileMock.mock.calls[0];
      // Partial marker should be present
      expect(writtenContent as string).toContain("(PARTIAL -- investigation interrupted)");
      // URL should be scrubbed
      expect(writtenContent as string).not.toContain("kinetica.example.com");
    });

    it("handler returns content array with type 'text'", async () => {
      const toolDef = grantedTool();
      const result = await toolDef.handler({ content: "Test report", partial: undefined }, {});

      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]).toMatchObject({ type: "text" });
    });
  });

  describe("consent", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    /** Builds a tool with an explicit consent state and a spyable inline prompt. */
    function toolWith(state: "unasked" | "granted" | "denied", inlineAnswer = true) {
      const consent = createSaveConsent();
      if (state !== "unasked") consent.record(state === "granted");
      const confirm = vi.fn().mockResolvedValue(inlineAnswer);
      return { toolDef: makeSaveReportTool({ consent, confirm }), confirm, consent };
    }

    it("writes on a recorded grant without asking a second time", async () => {
      const { toolDef, confirm } = toolWith("granted");
      await toolDef.handler({ content: "## Report", partial: undefined }, {});

      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledOnce();
      expect(confirm).not.toHaveBeenCalled();
    });

    it("consumes the grant, so the next save has to ask again", async () => {
      const { toolDef, confirm } = toolWith("granted");
      await toolDef.handler({ content: "## First", partial: undefined }, {});
      await toolDef.handler({ content: "## Second", partial: undefined }, {});

      expect(confirm).toHaveBeenCalledOnce();
      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledTimes(2);
    });

    it("does not write when the operator declined", async () => {
      const { toolDef } = toolWith("denied");
      await toolDef.handler({ content: "## Report", partial: undefined }, {});

      expect(vi.mocked(fsPromises.writeFile)).not.toHaveBeenCalled();
    });

    it("never re-prompts after a decline", async () => {
      const { toolDef, confirm } = toolWith("denied");
      await toolDef.handler({ content: "## Report", partial: undefined }, {});

      expect(confirm).not.toHaveBeenCalled();
    });

    it("tells the model the report was not saved and not to retry", async () => {
      const { toolDef } = toolWith("denied");
      const result = await toolDef.handler({ content: "## Report", partial: undefined }, {});

      const [block] = result.content as { text: string }[];
      expect(block.text).toMatch(/not saved/i);
      expect(block.text).toMatch(/do not retry|don't retry/i);
    });

    it("prompts inline when the model skipped confirm_save_report", async () => {
      const { toolDef, confirm } = toolWith("unasked");
      await toolDef.handler({ content: "## Report", partial: undefined }, {});

      expect(confirm).toHaveBeenCalledOnce();
      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledOnce();
    });

    it("skips the write when the inline fallback is declined", async () => {
      const { toolDef } = toolWith("unasked", false);
      await toolDef.handler({ content: "## Report", partial: undefined }, {});

      expect(vi.mocked(fsPromises.writeFile)).not.toHaveBeenCalled();
    });

    it("checkpoints a partial report without consent and without prompting", async () => {
      const { toolDef, confirm } = toolWith("unasked");
      await toolDef.handler({ content: "## Partial", partial: true }, {});

      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledOnce();
      expect(confirm).not.toHaveBeenCalled();
    });

    it("saves a partial checkpoint even after a decline -- budget pressure outranks it", async () => {
      const { toolDef } = toolWith("denied");
      await toolDef.handler({ content: "## Partial", partial: true }, {});

      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledOnce();
    });

    it("leaves a pending grant intact across a partial checkpoint", async () => {
      const { toolDef, confirm } = toolWith("granted");
      await toolDef.handler({ content: "## Partial", partial: true }, {});
      await toolDef.handler({ content: "## Final", partial: undefined }, {});

      // The checkpoint must not have eaten the operator's yes.
      expect(confirm).not.toHaveBeenCalled();
      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledTimes(2);
    });
  });
});
