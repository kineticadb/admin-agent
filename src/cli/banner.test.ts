import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printBanner, LOGO } from "./banner.js";

describe("LOGO constant", () => {
  it("contains KINETICA block art with box-drawing characters", () => {
    expect(LOGO).toContain("█████╔╝");
    expect(LOGO).toContain("╚═╝");
  });

  it("has 6 rows", () => {
    const rows = LOGO.split("\n");
    expect(rows).toHaveLength(6);
  });

  it("fits within 80-column terminal width", () => {
    const rows = LOGO.split("\n");
    for (const row of rows) {
      expect(row.length).toBeLessThanOrEqual(80);
    }
  });
});

describe("printBanner with logo", () => {
  let stderrOutput: string[];

  beforeEach(() => {
    stderrOutput = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrOutput.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the logo to stderr", () => {
    printBanner();
    const output = stderrOutput.join("");
    expect(output).toContain("█████");
  });

  it("writes the logo before the version line", () => {
    printBanner();
    const output = stderrOutput.join("");
    const logoIndex = output.indexOf("█████╔╝");
    const versionIndex = output.indexOf("admin-agent");
    expect(logoIndex).toBeLessThan(versionIndex);
  });

  it("has a blank line between logo and version", () => {
    printBanner();
    const output = stderrOutput.join("");
    // Logo ends with ╚═╝ + ANSI reset + \n\n before subtitle
    expect(output).toMatch(/╚═╝\x1b\[0m\n\n/);
  });

  it("returns a string containing the version", () => {
    const result = printBanner();
    expect(result).toMatch(/\d+\.\d+\.\d+/);
  });

  it("omits the model line when no model is passed", () => {
    printBanner();
    expect(stderrOutput.join("")).not.toContain("Model:");
  });

  it("prints 'Model: <name>' beneath the subtitle when a model is passed", () => {
    printBanner("haiku");
    const output = stderrOutput.join("");
    expect(output).toContain("Model: haiku");
    // Model line must appear AFTER the version subtitle, not before.
    const subtitleIdx = output.indexOf("admin-agent");
    const modelIdx = output.indexOf("Model: haiku");
    expect(modelIdx).toBeGreaterThan(subtitleIdx);
  });

  it("accepts any supported model shorthand", () => {
    printBanner("opus");
    expect(stderrOutput.join("")).toContain("Model: opus");
  });
});
