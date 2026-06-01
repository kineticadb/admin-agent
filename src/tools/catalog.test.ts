import { describe, it, expect } from "vitest";
import { TOOL_CATALOG, buildEvidenceChecklist } from "./catalog.js";
import {
  DIAGNOSTIC_TOOL_NAMES,
  MUTATION_TOOL_NAMES,
  ALTER_TABLE_COLUMNS_TOOL_NAME,
} from "./index.js";

describe("TOOL_CATALOG coverage", () => {
  it("has an entry for every diagnostic tool", () => {
    for (const name of DIAGNOSTIC_TOOL_NAMES) {
      expect(TOOL_CATALOG[name]).toBeDefined();
      expect(TOOL_CATALOG[name].reveals.length).toBeGreaterThan(0);
      expect(TOOL_CATALOG[name].whenToUse.length).toBeGreaterThan(0);
    }
  });

  it("has an entry for every mutation tool", () => {
    for (const name of MUTATION_TOOL_NAMES) {
      expect(TOOL_CATALOG[name]).toBeDefined();
      expect(TOOL_CATALOG[name].reveals.length).toBeGreaterThan(0);
      expect(TOOL_CATALOG[name].whenToUse.length).toBeGreaterThan(0);
    }
  });

  it("has an entry for the alter_table_columns self-approving tool", () => {
    expect(TOOL_CATALOG[ALTER_TABLE_COLUMNS_TOOL_NAME]).toBeDefined();
  });

  it("has no catalog entries for tools that don't exist in any tuple", () => {
    const allTupleNames: readonly string[] = [
      ...DIAGNOSTIC_TOOL_NAMES,
      ...MUTATION_TOOL_NAMES,
      ALTER_TABLE_COLUMNS_TOOL_NAME,
    ];
    for (const name of Object.keys(TOOL_CATALOG)) {
      expect(allTupleNames).toContain(name);
    }
  });

  it("catalog size equals sum of tuple sizes (no orphans)", () => {
    const expected = DIAGNOSTIC_TOOL_NAMES.length + MUTATION_TOOL_NAMES.length + 1; // alter_table_columns
    expect(Object.keys(TOOL_CATALOG).length).toBe(expected);
  });
});

describe("buildEvidenceChecklist", () => {
  const checklist = buildEvidenceChecklist();

  it("starts with a markdown table header", () => {
    const lines = checklist.split("\n");
    expect(lines[0]).toBe("| Tool | What it reveals | When to use |");
    expect(lines[1]).toBe("|------|----------------|-------------|");
  });

  it("contains a row for every diagnostic tool", () => {
    for (const name of DIAGNOSTIC_TOOL_NAMES) {
      expect(checklist).toContain(`| ${name} |`);
    }
  });

  it("contains a row for every mutation tool", () => {
    for (const name of MUTATION_TOOL_NAMES) {
      expect(checklist).toContain(`| ${name} |`);
    }
  });

  it("contains a row for alter_table_columns", () => {
    expect(checklist).toContain(`| ${ALTER_TABLE_COLUMNS_TOOL_NAME} |`);
  });

  it("renders diagnostic tools before mutation tools", () => {
    const diagIdx = checklist.indexOf(DIAGNOSTIC_TOOL_NAMES[0]);
    const mutIdx = checklist.indexOf(MUTATION_TOOL_NAMES[0]);
    expect(diagIdx).toBeGreaterThan(-1);
    expect(mutIdx).toBeGreaterThan(-1);
    expect(diagIdx).toBeLessThan(mutIdx);
  });

  it("every row has exactly three pipe-delimited columns", () => {
    const lines = checklist.split("\n").slice(2); // skip header + separator
    for (const line of lines) {
      // 4 pipes → 3 columns (leading, 2 internal, trailing)
      const pipeCount = (line.match(/\|/g) ?? []).length;
      expect(pipeCount).toBe(4);
    }
  });

  it("includes kinetica_get_system_properties", () => {
    expect(checklist).toContain("| kinetica_get_system_properties |");
  });
});
