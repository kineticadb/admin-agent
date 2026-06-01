/**
 * Tests for the save_report MCP tool factory.
 *
 * Verifies:
 * - makeSaveReportTool() returns a valid MCP tool definition with name "save_report"
 * - formatTimestamp() produces YYYY-MM-DD-HHmmss in UTC
 * - Reports are saved to reports/ directory with timestamped filenames
 * - Credential scrubbing is applied before writing
 * - Partial reports include the (PARTIAL -- investigation interrupted) marker
 * - Directory is created automatically (recursive: true)
 * - Tool handler returns filepath confirmation message
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSaveReportTool, formatTimestamp } from "./save-report.js";

// Mock node:fs/promises to avoid real file I/O
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import * as fsPromises from "node:fs/promises";

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
      const toolDef = makeSaveReportTool();
      expect(toolDef.name).toBe("save_report");
    });

    it("returns a tool definition with a description", () => {
      const toolDef = makeSaveReportTool();
      expect(typeof toolDef.description).toBe("string");
      expect(toolDef.description.length).toBeGreaterThan(0);
    });
  });

  describe("handler behavior", () => {
    it("creates reports/ directory with recursive:true", async () => {
      const toolDef = makeSaveReportTool();
      await toolDef.handler({ content: "## Report\nSome content", partial: undefined }, {});

      const mkdirMock = vi.mocked(fsPromises.mkdir);
      expect(mkdirMock).toHaveBeenCalledOnce();
      const [, options] = mkdirMock.mock.calls[0];
      expect(options).toEqual({ recursive: true });
    });

    it("writes file with kinetica-diag-YYYY-MM-DD-HHmmss.md filename", async () => {
      const toolDef = makeSaveReportTool();
      await toolDef.handler({ content: "## Report\nSome content", partial: undefined }, {});

      const writeFileMock = vi.mocked(fsPromises.writeFile);
      expect(writeFileMock).toHaveBeenCalledOnce();
      const [filepath] = writeFileMock.mock.calls[0];
      expect(typeof filepath).toBe("string");
      expect(filepath as string).toMatch(/kinetica-diag-\d{4}-\d{2}-\d{2}-\d{6}\.md$/);
    });

    it("writes file to reports/ subdirectory", async () => {
      const toolDef = makeSaveReportTool();
      await toolDef.handler({ content: "## Report\nSome content", partial: undefined }, {});

      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const [filepath] = writeFileMock.mock.calls[0];
      expect(filepath as string).toContain("/reports/");
    });

    it("scrubs credentials from content before writing", async () => {
      const toolDef = makeSaveReportTool();
      const sensitiveContent = "Connected to https://kinetica.example.com:9191/api\n## Summary";
      await toolDef.handler({ content: sensitiveContent, partial: undefined }, {});

      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const [, writtenContent] = writeFileMock.mock.calls[0];
      expect(writtenContent as string).not.toContain("kinetica.example.com");
      expect(writtenContent as string).toContain("[REDACTED]");
      expect(writtenContent as string).toContain("## Summary");
    });

    it("writes UTF-8 encoded files", async () => {
      const toolDef = makeSaveReportTool();
      await toolDef.handler({ content: "## Report", partial: undefined }, {});

      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const [, , encoding] = writeFileMock.mock.calls[0];
      expect(encoding).toBe("utf-8");
    });

    it("returns filepath in content text", async () => {
      const toolDef = makeSaveReportTool();
      const result = await toolDef.handler({ content: "## Report", partial: undefined }, {});

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toMatch(/^Report saved: .+\.md$/);
    });

    it("prepends PARTIAL marker when partial=true", async () => {
      const toolDef = makeSaveReportTool();
      await toolDef.handler({ content: "## Partial Report", partial: true }, {});

      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const [, writtenContent] = writeFileMock.mock.calls[0];
      expect(writtenContent as string).toContain("(PARTIAL -- investigation interrupted)");
      expect(writtenContent as string).toMatch(/^\(PARTIAL -- investigation interrupted\)\n\n/);
    });

    it("does not prepend PARTIAL marker when partial=false", async () => {
      const toolDef = makeSaveReportTool();
      await toolDef.handler({ content: "## Full Report", partial: false }, {});

      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const [, writtenContent] = writeFileMock.mock.calls[0];
      expect(writtenContent as string).not.toContain("(PARTIAL -- investigation interrupted)");
    });

    it("does not prepend PARTIAL marker when partial is omitted", async () => {
      const toolDef = makeSaveReportTool();
      await toolDef.handler({ content: "## Full Report", partial: undefined }, {});

      const writeFileMock = vi.mocked(fsPromises.writeFile);
      const [, writtenContent] = writeFileMock.mock.calls[0];
      expect(writtenContent as string).not.toContain("(PARTIAL -- investigation interrupted)");
    });

    it("applies credential scrubbing AFTER prepending partial marker", async () => {
      const toolDef = makeSaveReportTool();
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
      const toolDef = makeSaveReportTool();
      const result = await toolDef.handler({ content: "Test report", partial: undefined }, {});

      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]).toMatchObject({ type: "text" });
    });
  });
});
