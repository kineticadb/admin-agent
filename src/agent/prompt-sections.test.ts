/**
 * Tests for the shared prompt section builders — inline bodies vs. on-demand cards.
 */

import { describe, it, expect } from "vitest";

import {
  buildFailurePatternsSection,
  buildReferenceSection,
  buildKnowledgeLibraryIntro,
} from "./prompt-sections.js";
import type { Playbook, Reference } from "../types/index.js";

const ref = (over: Partial<Reference> = {}): Reference => ({
  title: "Kinetica SQL Dialect",
  category: "sql-syntax",
  keywords: ["sql"],
  summary: "PostgreSQL baseline plus the false-friends table.",
  readWhen: "Before writing ANY SQL.",
  body: "## Overview\n\nDIALECT BODY TEXT.\n\n## False Friends\n\nTRY_CAST fails.",
  filename: "sql-dialect.md",
  kind: "reference",
  ...over,
});

const pb = (over: Partial<Playbook> = {}): Playbook => ({
  title: "Memory Pressure",
  category: "performance",
  severity: "warning",
  keywords: ["memory"],
  body: "## Symptoms\n\n- Slow queries\n- Eviction warnings\n\n## Remediation\n\nRAISE THE LIMIT.",
  filename: "memory-pressure.md",
  kind: "playbook",
  ...over,
});

// ---------------------------------------------------------------------------
// buildFailurePatternsSection
// ---------------------------------------------------------------------------

describe("buildFailurePatternsSection", () => {
  it("returns an empty string when there are no playbooks", () => {
    expect(buildFailurePatternsSection()).toBe("");
    expect(buildFailurePatternsSection([])).toBe("");
  });

  it("keeps the section heading so prompt ordering assertions still hold", () => {
    expect(buildFailurePatternsSection([pb()])).toContain("### Common Failure Patterns");
  });

  it("renders an on-demand playbook as a card, not as a body", () => {
    const section = buildFailurePatternsSection([pb()]);
    expect(section).toContain("memory-pressure");
    expect(section).toContain("warning");
    expect(section).toContain("Slow queries; Eviction warnings");
    expect(section).not.toContain("RAISE THE LIMIT");
  });

  it("renders an inline playbook in full, in the original format", () => {
    const section = buildFailurePatternsSection([pb({ disclosure: "inline" })]);
    expect(section).toContain("**Memory Pressure:**");
    expect(section).toContain("RAISE THE LIMIT");
  });

  it("names the read tool so a matching card leads somewhere", () => {
    expect(buildFailurePatternsSection([pb()])).toContain("kinetica_knowledge_read");
  });
});

// ---------------------------------------------------------------------------
// buildReferenceSection
// ---------------------------------------------------------------------------

describe("buildReferenceSection", () => {
  it("returns an empty string when there are no references", () => {
    expect(buildReferenceSection()).toBe("");
    expect(buildReferenceSection([])).toBe("");
  });

  it("keeps the section heading", () => {
    expect(buildReferenceSection([ref()])).toContain("### Reference Knowledge");
  });

  it("renders an on-demand reference as a card carrying its trigger", () => {
    const section = buildReferenceSection([ref()]);
    expect(section).toContain("sql-dialect");
    expect(section).toContain("PostgreSQL baseline plus the false-friends table.");
    expect(section).toContain("Before writing ANY SQL.");
    expect(section).not.toContain("DIALECT BODY TEXT");
  });

  it("renders an inline reference in full", () => {
    const section = buildReferenceSection([ref({ disclosure: "inline" })]);
    expect(section).toContain("**Kinetica SQL Dialect:**");
    expect(section).toContain("DIALECT BODY TEXT");
  });

  it("forceInline overrides a document's own on-demand disclosure", () => {
    const section = buildReferenceSection([ref()], { forceInline: true });
    expect(section).toContain("DIALECT BODY TEXT");
    expect(section).not.toMatch(/\| *id *\|/);
  });

  it("lists sections on a card only for a long document", () => {
    const short = buildReferenceSection([ref()]);
    expect(short).not.toContain("Sections:");

    const long = buildReferenceSection([
      ref({ body: `## Overview\n\n${"word ".repeat(3000)}\n\n## WAL\n\nx` }),
    ]);
    expect(long).toContain("Sections:");
    expect(long).toContain("WAL");
  });

  it("escapes a pipe so one summary cannot break the table", () => {
    const section = buildReferenceSection([ref({ summary: "a | b" })]);
    expect(section).toContain("a \\| b");
  });

  it("accepts a heading override so two blocks cannot look like one section", () => {
    // Both prompts render bundle references separately from general ones, on
    // different tiers. Under one shared heading the second block reads as
    // superseding the first — worse now that one may be cards and the other body text.
    const section = buildReferenceSection([ref()], { heading: "### Bundle Parsing Knowledge" });
    expect(section).toContain("### Bundle Parsing Knowledge");
    expect(section).not.toContain("### Reference Knowledge");
  });

  it("renders cards and inline bodies together, cards first", () => {
    const section = buildReferenceSection([
      ref({ disclosure: "inline", filename: "mutation-safety.md", title: "Mutation Safety" }),
      ref(),
    ]);
    expect(section.indexOf("sql-dialect")).toBeLessThan(section.indexOf("**Mutation Safety:**"));
  });
});

// ---------------------------------------------------------------------------
// buildKnowledgeLibraryIntro
// ---------------------------------------------------------------------------

describe("buildKnowledgeLibraryIntro", () => {
  it("returns an empty string when every document is inline", () => {
    expect(buildKnowledgeLibraryIntro([ref({ disclosure: "inline" })])).toBe("");
    expect(buildKnowledgeLibraryIntro([])).toBe("");
  });

  it("explains the tool and states that triggers are requirements", () => {
    const intro = buildKnowledgeLibraryIntro([ref(), pb()]);
    expect(intro).toContain("## Knowledge Library");
    expect(intro).toContain("kinetica_knowledge_read");
    expect(intro).toMatch(/requirement/i);
  });

  it("tells the agent to re-read after compaction", () => {
    expect(buildKnowledgeLibraryIntro([ref()])).toMatch(/compact/i);
  });

  it("tells the agent to cite the ids it read", () => {
    expect(buildKnowledgeLibraryIntro([ref()])).toContain("Evidence Collected");
  });
});
