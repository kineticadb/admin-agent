/**
 * Tests for knowledge-document normalization — splitSections and normalizeDoc.
 */

import { describe, it, expect } from "vitest";

import { splitSections, normalizeDoc, MAX_DOC_TOKENS } from "./normalize-doc.js";
import type { Playbook, Reference } from "../types/index.js";

const reference = (over: Partial<Reference> = {}): Reference => ({
  title: "Test Reference",
  category: "testing",
  keywords: ["test"],
  body: "Body text.",
  filename: "test-reference.md",
  ...over,
});

const playbook = (over: Partial<Playbook> = {}): Playbook => ({
  ...reference(),
  severity: "warning",
  filename: "test-playbook.md",
  ...over,
});

// ---------------------------------------------------------------------------
// splitSections
// ---------------------------------------------------------------------------

describe("splitSections", () => {
  it("splits on '##' headings", () => {
    const sections = splitSections("## Alpha\n\nOne\n\n## Beta\n\nTwo");
    expect(sections.map((s) => s.heading)).toEqual(["Alpha", "Beta"]);
    expect(sections[0].body).toBe("One");
  });

  it("splits on '###' when that is the shallowest level used", () => {
    const sections = splitSections("### Log line format\n\nA\n\n### Files of interest\n\nB");
    expect(sections.map((s) => s.heading)).toEqual(["Log line format", "Files of interest"]);
  });

  it("keeps '###' subsections inside their '##' parent", () => {
    const body = "## Families\n\nIntro\n\n### One\n\nA\n\n### Two\n\nB\n\n## Rules\n\nC";
    const sections = splitSections(body);
    expect(sections.map((s) => s.heading)).toEqual(["Families", "Rules"]);
    expect(sections[0].body).toContain("### One");
    expect(sections[0].body).toContain("### Two");
  });

  it("heads preamble before the first heading as '(intro)'", () => {
    const sections = splitSections("Some preamble.\n\n## Alpha\n\nOne");
    expect(sections[0]).toEqual({ heading: "(intro)", body: "Some preamble." });
    expect(sections[1].heading).toBe("Alpha");
  });

  it("returns a single '(intro)' section for a body with no headings", () => {
    expect(splitSections("Just prose.")).toEqual([{ heading: "(intro)", body: "Just prose." }]);
  });

  it("returns an empty array for an empty body", () => {
    expect(splitSections("   ")).toEqual([]);
  });

  it("ignores '#' inside a fenced code block", () => {
    const body = "## Alpha\n\n```bash\n## not a heading\n```\n\n## Beta\n\nTwo";
    expect(splitSections(body).map((s) => s.heading)).toEqual(["Alpha", "Beta"]);
  });
});

// ---------------------------------------------------------------------------
// normalizeDoc — derived fields
// ---------------------------------------------------------------------------

describe("normalizeDoc", () => {
  it("derives id from the filename when absent", () => {
    expect(normalizeDoc(reference({ filename: "gpudb-conf.md" })).id).toBe("gpudb-conf");
  });

  it("keeps an id the loader already set", () => {
    expect(normalizeDoc(reference({ id: "explicit" })).id).toBe("explicit");
  });

  it("defaults disclosure to on-demand", () => {
    expect(normalizeDoc(reference()).disclosure).toBe("on-demand");
  });

  it("honours an explicit inline disclosure", () => {
    expect(normalizeDoc(reference({ disclosure: "inline" })).disclosure).toBe("inline");
  });

  it("infers kind from the presence of severity when the loader set none", () => {
    expect(normalizeDoc(playbook()).kind).toBe("playbook");
    expect(normalizeDoc(reference()).kind).toBe("reference");
  });

  it("keeps the kind the loader set", () => {
    expect(normalizeDoc(reference({ kind: "bundle-reference" })).kind).toBe("bundle-reference");
  });

  it("prefers the frontmatter summary", () => {
    expect(normalizeDoc(reference({ summary: "Authored." })).summary).toBe("Authored.");
  });

  it("derives a playbook summary from its Symptoms bullets", () => {
    const doc = playbook({
      body: "## Symptoms\n\n- Slow queries\n- Eviction warnings\n\n## Detection\n\nRun a query.",
    });
    expect(normalizeDoc(doc).summary).toBe("Slow queries; Eviction warnings");
  });

  it("derives a reference summary from the first sentence of Overview", () => {
    const doc = reference({
      body: "## Overview\n\nThe master config file. It has many sections.\n\n## More\n\nx",
    });
    expect(normalizeDoc(doc).summary).toBe("The master config file.");
  });

  it("falls back to the title when nothing else is available", () => {
    expect(normalizeDoc(reference({ body: "No headings at all here." })).summary).toBe(
      "Test Reference",
    );
  });

  it("collapses newlines so a summary always fits one table cell", () => {
    const doc = playbook({ body: "## Symptoms\n\n- One\n  continued\n- Two" });
    expect(normalizeDoc(doc).summary).not.toContain("\n");
  });

  it("clips a very long derived summary", () => {
    const doc = playbook({ body: `## Symptoms\n\n- ${"x".repeat(400)}` });
    const { summary } = normalizeDoc(doc);
    expect(summary.length).toBeLessThanOrEqual(201);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("defaults readWhen to an empty string", () => {
    expect(normalizeDoc(reference()).readWhen).toBe("");
  });

  it("estimates body tokens", () => {
    expect(normalizeDoc(reference({ body: "x".repeat(400) })).tokens).toBe(100);
  });

  it("carries severity for playbooks and omits it for references", () => {
    expect(normalizeDoc(playbook({ severity: "critical" })).severity).toBe("critical");
    expect(normalizeDoc(reference()).severity).toBeUndefined();
  });

  it("exposes a MAX_DOC_TOKENS well above the largest real document", () => {
    expect(MAX_DOC_TOKENS).toBeGreaterThan(3_500);
  });
});
