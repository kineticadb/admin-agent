/**
 * Structural validators for the diagnostic report markdown the model produces.
 *
 * Intentionally NOT an LLM-as-judge — these are fast, deterministic regex/order
 * checks that pin the invariants declared in knowledge/templates/report.md and
 * enforced by the system prompt (Metadata -> Summary -> Remediation -> Root
 * Cause Analysis -> Evidence Collected -> Evidence Gaps -> Mutations Applied
 * -> Post-Remediation Verification).
 *
 * Returns a machine-readable result so the eval runner can distinguish
 * "model didn't write a report at all" from "report structure is wrong".
 */

export type AssertionResult = {
  readonly passed: boolean;
  readonly errors: readonly string[];
};

/** Required top-level sections, in the order the template fixes. */
export const REQUIRED_SECTIONS: readonly string[] = [
  "## Summary",
  "## Remediation",
  "## Root Cause Analysis",
  "## Evidence Collected",
  "## Evidence Gaps",
  "## Mutations Applied",
  "## Post-Remediation Verification",
];

/** Validate the model's report markdown against the template invariants. */
export function validateReportStructure(markdown: string): AssertionResult {
  const errors: string[] = [];

  if (!markdown.trimStart().startsWith("# Kinetica Diagnostic Report")) {
    errors.push("Report must start with a top-level heading '# Kinetica Diagnostic Report'.");
  }

  const indices = REQUIRED_SECTIONS.map((s) => ({
    section: s,
    idx: markdown.indexOf(s),
  }));

  for (const { section, idx } of indices) {
    if (idx === -1) {
      errors.push(`Missing required section heading: '${section}'.`);
    }
  }

  for (let i = 0; i < indices.length - 1; i++) {
    const current = indices[i];
    const next = indices[i + 1];
    if (current.idx !== -1 && next.idx !== -1 && current.idx > next.idx) {
      errors.push(`Section order violated: '${current.section}' must precede '${next.section}'.`);
    }
  }

  // Metadata table: the prompt instructs the model to include Investigation
  // Date/Time, Kinetica Version, and Tool Calls at minimum. We check for the
  // labels rather than the exact table format (the model may tweak padding).
  const metadataLabels = ["Investigation Date", "Kinetica Version", "Tool Calls"];
  for (const label of metadataLabels) {
    if (!markdown.includes(label)) {
      errors.push(`Metadata table missing expected label: '${label}'.`);
    }
  }

  return { passed: errors.length === 0, errors };
}
