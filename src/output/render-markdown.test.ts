import { describe, it, expect } from "vitest";
import pc from "picocolors";
import { renderMarkdownLine } from "./render-markdown.js";
import { purple, pink } from "./brand-colors.js";

// Mirror the implementation's width fallback so rule assertions hold whether or not
// the test runner is attached to a TTY.
const W = process.stderr.columns && process.stderr.columns > 0 ? process.stderr.columns : 80;

describe("renderMarkdownLine", () => {
  describe("bold (**text**)", () => {
    it("renders single bold span", () => {
      expect(renderMarkdownLine("The **CPU** is high")).toBe(`The ${pc.bold("CPU")} is high`);
    });

    it("renders multiple bold spans in one line", () => {
      expect(renderMarkdownLine("The **CPU** on **rank 1** is high")).toBe(
        `The ${pc.bold("CPU")} on ${pc.bold("rank 1")} is high`,
      );
    });

    it("renders bold at start of line", () => {
      expect(renderMarkdownLine("**Warning:** something happened")).toBe(
        `${pc.bold("Warning:")} something happened`,
      );
    });

    it("renders entire line as bold", () => {
      expect(renderMarkdownLine("**everything bold**")).toBe(pc.bold("everything bold"));
    });

    it("uses non-greedy matching (does not merge spans)", () => {
      expect(renderMarkdownLine("**a** and **b**")).toBe(`${pc.bold("a")} and ${pc.bold("b")}`);
    });

    it("leaves unmatched single ** unchanged", () => {
      expect(renderMarkdownLine("a ** b")).toBe("a ** b");
    });
  });

  describe("headers (# text)", () => {
    it("renders h1 as bold brand-pink with a leading blank line and an underline rule", () => {
      expect(renderMarkdownLine("# Title")).toBe(
        `\n${pc.bold(pink("Title"))}\n${pc.dim("─".repeat(W))}`,
      );
    });

    it("renders h2 as an accent bar + bold brand-pink, preceded by a blank line", () => {
      expect(renderMarkdownLine("## System Health")).toBe(`\n${pc.bold(pink("▌ System Health"))}`);
    });

    it("renders h3 as bold brand-purple, kept tight", () => {
      expect(renderMarkdownLine("### Subsection")).toBe(pc.bold(purple("Subsection")));
    });

    it("renders h6 like a sub-section (bold brand-purple)", () => {
      expect(renderMarkdownLine("###### Deep")).toBe(pc.bold(purple("Deep")));
    });

    it("does not match # without space after", () => {
      expect(renderMarkdownLine("#noheading")).toBe("#noheading");
    });

    it("does not match # in the middle of a line", () => {
      expect(renderMarkdownLine("issue #42 is open")).toBe("issue #42 is open");
    });
  });

  describe("horizontal rules", () => {
    it("renders --- as a dim full-width rule", () => {
      expect(renderMarkdownLine("---")).toBe(pc.dim("─".repeat(W)));
    });

    it("renders *** and ___ as rules too", () => {
      expect(renderMarkdownLine("***")).toBe(pc.dim("─".repeat(W)));
      expect(renderMarkdownLine("___")).toBe(pc.dim("─".repeat(W)));
    });

    it("does not treat two dashes as a rule", () => {
      expect(renderMarkdownLine("--")).toBe("--");
    });
  });

  describe("list items", () => {
    it("renders a dash bullet with a brand-purple dot", () => {
      expect(renderMarkdownLine("- a finding")).toBe(`${purple("•")} a finding`);
    });

    it("preserves indentation on nested bullets", () => {
      expect(renderMarkdownLine("  - nested")).toBe(`  ${purple("•")} nested`);
    });

    it("uses a red ✗ glyph and tints the token when the item names a hard severity", () => {
      expect(renderMarkdownLine("- ERROR in rank 5")).toBe(
        `${pc.red("✗")} ${pc.red("ERROR")} in rank 5`,
      );
    });

    it("uses a yellow ⚠ glyph for a WARN item", () => {
      expect(renderMarkdownLine("- WARN tcs_per_tom low")).toBe(
        `${pc.yellow("⚠")} ${pc.yellow("WARN")} tcs_per_tom low`,
      );
    });

    it("applies inline styling inside bullet content", () => {
      expect(renderMarkdownLine("- use `show_table`")).toBe(
        `${purple("•")} use ${purple("show_table")}`,
      );
    });
  });

  describe("inline code", () => {
    it("tints `code` spans brand-purple and strips the backticks", () => {
      expect(renderMarkdownLine("run `health_check` now")).toBe(
        `run ${purple("health_check")} now`,
      );
    });
  });

  describe("semantic severity tinting (case-sensitive, whole word)", () => {
    it("tints an uppercase FATAL token red in prose", () => {
      expect(renderMarkdownLine("status FATAL detected")).toBe(
        `status ${pc.red("FATAL")} detected`,
      );
    });

    it("tints HEALTHY green", () => {
      expect(renderMarkdownLine("cluster HEALTHY")).toBe(`cluster ${pc.green("HEALTHY")}`);
    });

    it("leaves lowercase 'errors' untouched to avoid prose false positives", () => {
      expect(renderMarkdownLine("found no errors today")).toBe("found no errors today");
    });
  });

  describe("no-op passthrough", () => {
    it("returns plain text unchanged", () => {
      expect(renderMarkdownLine("just a regular line")).toBe("just a regular line");
    });

    it("returns empty string unchanged", () => {
      expect(renderMarkdownLine("")).toBe("");
    });

    it("returns a table line unchanged (aligner handles tables separately)", () => {
      expect(renderMarkdownLine("| A | B |")).toBe("| A | B |");
    });

    it("returns a line with single asterisks unchanged", () => {
      expect(renderMarkdownLine("*italic* text")).toBe("*italic* text");
    });
  });

  describe("immutability", () => {
    it("does not mutate the input string", () => {
      const input = "**bold** text";
      const original = input;
      renderMarkdownLine(input);
      expect(input).toBe(original);
    });
  });
});
