import { describe, it, expect } from "vitest";
import { REPORT_TEMPLATE, REPORT_SECTIONS, REPORT_SECTION_ORDER } from "./report-template.js";
import { REQUIRED_SECTIONS } from "../evals/report-assertions.js";

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
    expect(REPORT_TEMPLATE).toContain("## Timeline");
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

  it("preserves canonical section ordering (Evidence Collected before Timeline before Evidence Gaps)", () => {
    const collectedIdx = REPORT_TEMPLATE.indexOf("## Evidence Collected");
    const timelineIdx = REPORT_TEMPLATE.indexOf("## Timeline");
    const gapsIdx = REPORT_TEMPLATE.indexOf("## Evidence Gaps");
    expect(collectedIdx).toBeLessThan(timelineIdx);
    expect(timelineIdx).toBeLessThan(gapsIdx);
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
      /\|\s*Time \(UTC\)\s*\|\s*Tool\s*\|\s*Parameters\s*\|\s*Before\s*\|\s*After\s*\|\s*Approval\s*\|\s*Verified\s*\|/,
    );
    expect(REPORT_TEMPLATE).toContain("APPROVED/DENIED");
  });
  it("scaffolds the Timeline table on a single UTC axis with source and as-observed columns", () => {
    expect(REPORT_TEMPLATE).toMatch(
      /\|\s*Time \(UTC\)\s*\|\s*Source\s*\|\s*As observed\s*\|\s*Event\s*\|/,
    );
    expect(REPORT_TEMPLATE).toMatch(/offset between its clock and UTC is unknown/i);
  });
});

describe("report section order — one declaration, three consumers", () => {
  /**
   * The bug this pins, measured 2026-09-16.
   *
   * The report layout was declared in three places: the template, the prompt's
   * prose "Section order" line, and REQUIRED_SECTIONS in the eval assertions.
   * The commit that added `## Timeline` to the template updated only the first
   * and the third. The prompt then shipped a template containing Timeline next
   * to a CRITICAL prose list that omitted it, telling the model "Do NOT reorder
   * sections" — two contradictory specs, one emphatic.
   *
   * Nothing failed for two weeks because Sonnet 4.6 happened to follow the
   * template. The SDK 0.2->0.3 upgrade moved the `sonnet` alias to Sonnet 5,
   * which followed the prose list instead, and all three eval scenarios failed:
   * one dropped Timeline, two emitted it outside the enumerated order.
   *
   * The order line is now derived from the template, so these assertions are
   * what stops the third declaration (the eval's) from drifting back out.
   */
  it("derives every template section, in template order", () => {
    const headings = [...REPORT_TEMPLATE.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
    expect(REPORT_SECTIONS).toEqual(headings);
    expect(REPORT_SECTIONS).toContain("Timeline");
  });

  it("renders the order line with every section in template order", () => {
    const positions = REPORT_SECTIONS.map((s) => REPORT_SECTION_ORDER.indexOf(s));
    expect(positions.every((p) => p !== -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(REPORT_SECTION_ORDER.startsWith("Metadata -> ")).toBe(true);
  });

  it("agrees with the eval's REQUIRED_SECTIONS — the third declaration", () => {
    expect(REQUIRED_SECTIONS).toEqual(REPORT_SECTIONS.map((s) => `## ${s}`));
  });

  it("has no code fences, which the heading regex assumes", () => {
    expect(REPORT_TEMPLATE).not.toContain("```");
  });
});
