import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageRoot } from "./load-playbooks.js";

function loadReportTemplateSync(): string {
  try {
    const root = findPackageRoot(__dirname);
    const path = join(root, "knowledge", "templates", "report.md");
    return readFileSync(path, "utf-8");
  } catch (err) {
    console.warn(`[report-template] failed to load knowledge/templates/report.md: ${String(err)}`);
    return "";
  }
}

// Sync at import keeps buildSystemPrompt() a pure function: by the time any
// caller runs, REPORT_TEMPLATE is a plain string constant.
export const REPORT_TEMPLATE: string = loadReportTemplateSync();

/**
 * The report's `##` section headings, in template order.
 *
 * DERIVED from the template rather than written out, because the prompt used to
 * state the order in prose AND ship the template, and the two drifted. The commit
 * that added `## Timeline` to the template (2026-09-03) left the prose list
 * untouched, so the prompt carried two contradictory specs — and the prose one was
 * labelled CRITICAL with "Do NOT reorder sections". Which spec the model obeyed
 * then depended on the model: Sonnet 4.6 followed the template and the evals stayed
 * green; Sonnet 5 followed the CRITICAL prose and dropped or misplaced Timeline in
 * all three eval scenarios. The bug was two weeks old and invisible until the SDK
 * upgrade moved the `sonnet` alias from 4.6 to 5.
 *
 * There is now one declaration — the template — and the prose renders from it, so
 * adding a section to the template can no longer leave the order line behind.
 *
 * The template contains no code fences (asserted in the sibling test), so a plain
 * heading match is safe here.
 */
export const REPORT_SECTIONS: readonly string[] = Object.freeze(
  [...REPORT_TEMPLATE.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim()),
);

/**
 * The prompt's section-order line, e.g. `Metadata -> Summary -> ...`.
 *
 * "Metadata" leads because the template opens with the metadata table rather than
 * a `##` heading, so it has no heading to derive from.
 */
export const REPORT_SECTION_ORDER: string = ["Metadata", ...REPORT_SECTIONS].join(" -> ");
