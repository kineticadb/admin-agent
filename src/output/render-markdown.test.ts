import { describe, it, expect } from "vitest";
import pc from "picocolors";
import { renderMarkdownLine } from "./render-markdown.js";

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

    it("renders bold at end of line", () => {
      expect(renderMarkdownLine("Status is **critical**")).toBe(`Status is ${pc.bold("critical")}`);
    });

    it("renders entire line as bold", () => {
      expect(renderMarkdownLine("**everything bold**")).toBe(pc.bold("everything bold"));
    });

    it("uses non-greedy matching (does not merge spans)", () => {
      const result = renderMarkdownLine("**a** and **b**");
      expect(result).toBe(`${pc.bold("a")} and ${pc.bold("b")}`);
    });

    it("leaves unmatched single ** unchanged", () => {
      expect(renderMarkdownLine("a ** b")).toBe("a ** b");
    });
  });

  describe("headers (# text)", () => {
    it("renders ## heading as bold without # prefix", () => {
      expect(renderMarkdownLine("## System Health")).toBe(pc.bold("System Health"));
    });

    it("renders # heading (h1)", () => {
      expect(renderMarkdownLine("# Title")).toBe(pc.bold("Title"));
    });

    it("renders ### heading (h3)", () => {
      expect(renderMarkdownLine("### Subsection")).toBe(pc.bold("Subsection"));
    });

    it("renders ###### heading (h6)", () => {
      expect(renderMarkdownLine("###### Deep")).toBe(pc.bold("Deep"));
    });

    it("does not match # without space after", () => {
      expect(renderMarkdownLine("#noheading")).toBe("#noheading");
    });

    it("does not match # in the middle of a line", () => {
      expect(renderMarkdownLine("issue #42 is open")).toBe("issue #42 is open");
    });
  });

  describe("no-op passthrough", () => {
    it("returns plain text unchanged", () => {
      expect(renderMarkdownLine("just a regular line")).toBe("just a regular line");
    });

    it("returns empty string unchanged", () => {
      expect(renderMarkdownLine("")).toBe("");
    });

    it("returns table line unchanged", () => {
      expect(renderMarkdownLine("| A | B |")).toBe("| A | B |");
    });

    it("returns line with single asterisks unchanged", () => {
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
