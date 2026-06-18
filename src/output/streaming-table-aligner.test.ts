/**
 * Tests for the streaming table aligner — a line-buffering adapter
 * that detects markdown table blocks in streamed text deltas,
 * reformats them for terminal display, and passes non-table content through.
 */

import { describe, it, expect } from "vitest";
import pc from "picocolors";
import { createStreamingTableAligner } from "./streaming-table-aligner.js";
import { pink } from "./brand-colors.js";

describe("createStreamingTableAligner", () => {
  describe("passthrough — plain text", () => {
    it("passes complete lines through immediately", () => {
      const aligner = createStreamingTableAligner();
      const output = aligner.push("Hello world\n");
      expect(output).toBe("Hello world\n");
    });

    it("buffers incomplete lines until newline arrives", () => {
      const aligner = createStreamingTableAligner();
      expect(aligner.push("partial")).toBe("");
      expect(aligner.push(" text\n")).toBe("partial text\n");
    });

    it("handles multiple complete lines in one push", () => {
      const aligner = createStreamingTableAligner();
      const output = aligner.push("line one\nline two\n");
      expect(output).toBe("line one\nline two\n");
    });

    it("handles empty string push", () => {
      const aligner = createStreamingTableAligner();
      expect(aligner.push("")).toBe("");
    });
  });

  describe("single table — buffered and aligned", () => {
    it("buffers table lines and flushes with box-drawing borders", () => {
      const aligner = createStreamingTableAligner();

      // Table lines are buffered (no output yet)
      expect(aligner.push("| Name | Age |\n")).toBe("");
      expect(aligner.push("| --- | --- |\n")).toBe("");
      expect(aligner.push("| Alice | 30 |\n")).toBe("");

      // Non-table line triggers table flush + the non-table line
      const output = aligner.push("Done.\n");

      // Should contain aligned table with borders, then "Done."
      expect(output).toContain("+-------+-----+");
      expect(output).toContain("| Name  | Age |");
      expect(output).toContain("| Alice | 30  |");
      expect(output).toContain("Done.\n");
    });

    it("flushes table at end of stream via flush()", () => {
      const aligner = createStreamingTableAligner();

      aligner.push("| Name | Age |\n");
      aligner.push("| --- | --- |\n");
      aligner.push("| Alice | 30 |\n");

      const output = aligner.flush();

      expect(output).toContain("+-------+-----+");
      expect(output).toContain("| Name  | Age |");
      expect(output).toContain("| Alice | 30  |");
    });
  });

  describe("table embedded in prose", () => {
    it("passes prose through and aligns table", () => {
      const aligner = createStreamingTableAligner();

      const before = aligner.push("Here are the results:\n");
      expect(before).toBe("Here are the results:\n");

      // Table lines buffered
      expect(aligner.push("| Metric | Value |\n")).toBe("");
      expect(aligner.push("| --- | --- |\n")).toBe("");
      expect(aligner.push("| CPU | 45% |\n")).toBe("");

      // Prose after table triggers flush
      const after = aligner.push("End of report.\n");
      expect(after).toContain("+--------+-------+");
      expect(after).toContain("| Metric | Value |");
      expect(after).toContain("| CPU    | 45%   |");
      expect(after).toContain("End of report.\n");
    });
  });

  describe("partial deltas — newline splits across pushes", () => {
    it("reassembles lines split across multiple push calls", () => {
      const aligner = createStreamingTableAligner();

      // "Hello world\n" split across three pushes
      expect(aligner.push("Hel")).toBe("");
      expect(aligner.push("lo wor")).toBe("");
      expect(aligner.push("ld\n")).toBe("Hello world\n");
    });

    it("reassembles table lines split across pushes", () => {
      const aligner = createStreamingTableAligner();

      // Table row split across pushes
      aligner.push("| Na");
      aligner.push("me | Age |\n");
      aligner.push("| --- | --- |\n");
      aligner.push("| Alice | 30 |\n");

      const output = aligner.flush();
      expect(output).toContain("| Name  | Age |");
      expect(output).toContain("| Alice | 30  |");
    });

    it("handles newline as a separate push", () => {
      const aligner = createStreamingTableAligner();

      expect(aligner.push("text")).toBe("");
      expect(aligner.push("\n")).toBe("text\n");
    });
  });

  describe("flush behavior", () => {
    it("flushes remaining line buffer content", () => {
      const aligner = createStreamingTableAligner();

      aligner.push("incomplete");
      const output = aligner.flush();
      expect(output).toBe("incomplete");
    });

    it("flushes pending table and remaining buffer", () => {
      const aligner = createStreamingTableAligner();

      aligner.push("| A | B |\n");
      aligner.push("| --- | --- |\n");
      aligner.push("| 1 | 2 |\n");
      aligner.push("trailing");

      const output = aligner.flush();
      expect(output).toContain("+-----+-----+");
      expect(output).toContain("trailing");
    });

    it("returns empty string when nothing buffered", () => {
      const aligner = createStreamingTableAligner();
      expect(aligner.flush()).toBe("");
    });

    it("resets state after flush", () => {
      const aligner = createStreamingTableAligner();

      aligner.push("first\n");
      aligner.flush();

      // After flush, new pushes should start clean
      const output = aligner.push("second\n");
      expect(output).toBe("second\n");
    });
  });

  describe("multiple tables separated by prose", () => {
    it("aligns each table independently", () => {
      const aligner = createStreamingTableAligner();

      // First table
      aligner.push("| A | B |\n");
      aligner.push("| - | - |\n");
      aligner.push("| 1 | 2 |\n");

      // Prose separating tables — triggers first table flush
      const mid = aligner.push("Between tables.\n");
      expect(mid).toContain("+-----+-----+");
      expect(mid).toContain("Between tables.\n");

      // Second table
      aligner.push("| X | Y | Z |\n");
      aligner.push("| - | - | - |\n");
      aligner.push("| a | b | c |\n");

      const end = aligner.flush();
      expect(end).toContain("+-----+-----+-----+");
      expect(end).toContain("| X   | Y   | Z   |");
    });
  });

  describe("immutability", () => {
    it("does not mutate input strings", () => {
      const aligner = createStreamingTableAligner();
      const input = "| A | B |\n";
      const original = input;
      aligner.push(input);
      expect(input).toBe(original);
    });
  });

  describe("markdown rendering in non-table lines", () => {
    it("renders bold markdown in streamed prose", () => {
      const aligner = createStreamingTableAligner();
      const output = aligner.push("The **CPU** is at 90%\n");
      expect(output).toBe(`The ${pc.bold("CPU")} is at 90%\n`);
    });

    it("renders an h2 heading as an accent bar + bold brand-pink (# stripped)", () => {
      const aligner = createStreamingTableAligner();
      const output = aligner.push("## System Health\n");
      expect(output).toBe(`\n${pc.bold(pink("▌ System Health"))}\n`);
    });

    it("renders bold in flushed lineBuffer", () => {
      const aligner = createStreamingTableAligner();
      aligner.push("Status: **critical**");
      const output = aligner.flush();
      expect(output).toBe(`Status: ${pc.bold("critical")}`);
    });

    it("renders bold inside table cells via reformatTableBlock", () => {
      const aligner = createStreamingTableAligner();
      aligner.push("| **Name** | Value |\n");
      aligner.push("| --- | --- |\n");
      aligner.push("| test | 42 |\n");
      const output = aligner.flush();
      // Bold in table cells should be rendered as terminal bold
      expect(output).toContain(pc.bold("Name"));
      expect(output).not.toContain("**Name**");
    });
  });

  describe("edge cases", () => {
    it("handles a line that starts with pipe but does not end with pipe", () => {
      const aligner = createStreamingTableAligner();
      // Not a table line — should pass through
      const output = aligner.push("| this is not a table\n");
      expect(output).toBe("| this is not a table\n");
    });

    it("handles empty table lines (just pipes)", () => {
      const aligner = createStreamingTableAligner();
      aligner.push("| | |\n");
      aligner.push("| - | - |\n");
      aligner.push("| a | b |\n");
      const output = aligner.flush();
      expect(output).toContain("+-----+-----+");
    });

    it("handles consecutive newlines (blank lines)", () => {
      const aligner = createStreamingTableAligner();
      const output = aligner.push("line one\n\nline three\n");
      expect(output).toBe("line one\n\nline three\n");
    });
  });
});
