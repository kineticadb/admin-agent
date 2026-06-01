import { describe, it, expect } from "vitest";
import { REPORT_TEMPLATE } from "./report-template.js";

describe("REPORT_TEMPLATE", () => {
  it("loads a non-empty string from disk at module-init time", () => {
    expect(typeof REPORT_TEMPLATE).toBe("string");
    expect(REPORT_TEMPLATE.length).toBeGreaterThan(0);
  });

  it("starts with the Kinetica Diagnostic Report heading", () => {
    expect(REPORT_TEMPLATE.startsWith("# Kinetica Diagnostic Report")).toBe(true);
  });

  it("includes all required report sections", () => {
    expect(REPORT_TEMPLATE).toContain("## Summary");
    expect(REPORT_TEMPLATE).toContain("## Remediation");
    expect(REPORT_TEMPLATE).toContain("## Root Cause Analysis");
    expect(REPORT_TEMPLATE).toContain("## Evidence Collected");
    expect(REPORT_TEMPLATE).toContain("## Evidence Gaps");
    expect(REPORT_TEMPLATE).toContain("## Mutations Applied");
    expect(REPORT_TEMPLATE).toContain("## Post-Remediation Verification");
  });

  it("preserves canonical section ordering (Summary before Remediation before Root Cause)", () => {
    const summaryIdx = REPORT_TEMPLATE.indexOf("## Summary");
    const remediationIdx = REPORT_TEMPLATE.indexOf("## Remediation");
    const rootCauseIdx = REPORT_TEMPLATE.indexOf("## Root Cause Analysis");
    expect(summaryIdx).toBeLessThan(remediationIdx);
    expect(remediationIdx).toBeLessThan(rootCauseIdx);
  });

  it("preserves canonical section ordering (Evidence Collected before Evidence Gaps)", () => {
    const collectedIdx = REPORT_TEMPLATE.indexOf("## Evidence Collected");
    const gapsIdx = REPORT_TEMPLATE.indexOf("## Evidence Gaps");
    expect(collectedIdx).toBeLessThan(gapsIdx);
  });

  it("preserves canonical section ordering (Mutations Applied before Post-Remediation)", () => {
    const mutationsIdx = REPORT_TEMPLATE.indexOf("## Mutations Applied");
    const postRemIdx = REPORT_TEMPLATE.indexOf("## Post-Remediation Verification");
    expect(mutationsIdx).toBeLessThan(postRemIdx);
  });

  it("includes the metadata table scaffolding", () => {
    expect(REPORT_TEMPLATE).toMatch(/\|\s*Field\s*\|\s*Value\s*\|/);
    expect(REPORT_TEMPLATE).toContain("**Investigation Date/Time (UTC)**");
    expect(REPORT_TEMPLATE).toContain("**Kinetica Version**");
    expect(REPORT_TEMPLATE).toContain("**Tool Calls**");
  });

  it("includes the Mutations Applied table scaffolding", () => {
    expect(REPORT_TEMPLATE).toMatch(
      /\|\s*Timestamp\s*\|\s*Tool\s*\|\s*Parameters\s*\|\s*Before\s*\|\s*After\s*\|\s*Approval\s*\|\s*Verified\s*\|/,
    );
    expect(REPORT_TEMPLATE).toContain("APPROVED/DENIED");
  });
});
