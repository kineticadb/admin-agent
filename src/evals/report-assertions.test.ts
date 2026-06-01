import { describe, it, expect } from "vitest";
import { validateReportStructure, REQUIRED_SECTIONS } from "./report-assertions.js";

describe("validateReportStructure", () => {
  const WELL_FORMED = [
    "# Kinetica Diagnostic Report",
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| **Investigation Date/Time (UTC)** | 2026-04-23 03:00:00 UTC |",
    "| **Kinetica Version** | 7.2.3.11 |",
    "| **Tool Calls** | 4 |",
    "",
    ...REQUIRED_SECTIONS.flatMap((s) => [s, "", "Body.", ""]),
  ].join("\n");

  it("passes on a well-formed report", () => {
    const result = validateReportStructure(WELL_FORMED);
    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("flags missing top-level heading", () => {
    const result = validateReportStructure(WELL_FORMED.replace("# Kinetica Diagnostic Report", ""));
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("top-level heading"))).toBe(true);
  });

  it("flags missing required sections", () => {
    const missing = WELL_FORMED.replace("## Root Cause Analysis", "");
    const result = validateReportStructure(missing);
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("Root Cause Analysis"))).toBe(true);
  });

  it("flags out-of-order sections", () => {
    // Swap Summary and Remediation
    const swapped = [
      "# Kinetica Diagnostic Report",
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| **Investigation Date/Time (UTC)** | t |",
      "| **Kinetica Version** | v |",
      "| **Tool Calls** | 0 |",
      "",
      "## Remediation",
      "",
      "## Summary",
      "",
      "## Root Cause Analysis",
      "",
      "## Evidence Collected",
      "",
      "## Evidence Gaps",
      "",
      "## Mutations Applied",
      "",
      "## Post-Remediation Verification",
    ].join("\n");
    const result = validateReportStructure(swapped);
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("Section order violated"))).toBe(true);
  });

  it("flags missing metadata labels", () => {
    const noVersion = WELL_FORMED.replace("**Kinetica Version**", "**Something Else**");
    const result = validateReportStructure(noVersion);
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("Kinetica Version"))).toBe(true);
  });
});
