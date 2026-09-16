/**
 * Knowledge-document normalization — resolve every derived field once.
 *
 * The loaders produce `Playbook` / `Reference` with the disclosure fields optional:
 * they fill in only what the filesystem tells them (`id`, `kind`) and pass frontmatter
 * through verbatim. This module turns one of those into a `KnowledgeDoc`, where nothing
 * is optional, so no renderer or tool ever re-derives a default — and two of them can
 * never disagree about what the default was.
 *
 * Pure, dependency-light, never throws.
 *
 * Exports:
 *   splitSections(body) — the document's own top-level sections
 *   normalizeDoc(doc)   — Playbook | Reference → KnowledgeDoc
 *   MAX_DOC_TOKENS      — the size at which a document should be split or fetched by section
 */

import { estimateTokens } from "../agent/prompt-budget.js";
import type { KnowledgeDoc, KnowledgeSection, Playbook, Reference } from "../types/index.js";

/**
 * Warn threshold for a single document, in estimated tokens.
 *
 * A tripwire, not a limit: the MCP layer's own cap is 25,000 and the largest document
 * in the corpus today is ~3,300, so this leaves real headroom while still firing well
 * before a document becomes an unreadable wall. The remedy it names is the tool's
 * `section` parameter, not deletion.
 */
export const MAX_DOC_TOKENS = 6_000;

/** Longest derived summary before clipping. Keeps a card row to roughly one line. */
const SUMMARY_MAX_CHARS = 200;

/** Heading under which body text preceding the first real heading is filed. */
const INTRO_HEADING = "(intro)";

// ---------------------------------------------------------------------------
// Section splitting
// ---------------------------------------------------------------------------

/** A markdown ATX heading of level 2-4, capturing its depth and text. */
const HEADING = /^(#{2,4})\s+(.*)$/;

/** A fenced code block delimiter (``` or ~~~), possibly indented. */
const FENCE = /^\s*(?:```|~~~)/;

/**
 * Index every heading in the body, skipping anything inside a fenced code block.
 *
 * The fence check is not defensive padding: several references embed shell and SQL
 * blocks whose comments start with `##`, and treating one as a heading would split a
 * section mid-example.
 */
function findHeadings(
  lines: readonly string[],
): readonly { line: number; depth: number; text: string }[] {
  return lines.reduce<{
    readonly inFence: boolean;
    readonly found: readonly { line: number; depth: number; text: string }[];
  }>(
    (acc, raw, line) => {
      if (FENCE.test(raw)) return { ...acc, inFence: !acc.inFence };
      if (acc.inFence) return acc;
      const match = HEADING.exec(raw);
      if (!match) return acc;
      return {
        ...acc,
        found: [...acc.found, { line, depth: match[1].length, text: match[2].trim() }],
      };
    },
    { inFence: false, found: [] },
  ).found;
}

/**
 * Split a document body into its own top-level sections.
 *
 * Splits at the SHALLOWEST heading level the document actually uses, rather than at a
 * fixed level. `support-bundle.md` is written entirely in `###` and would otherwise
 * yield no sections at all; `service-management.md` nests `###` under `##`, and
 * splitting on both would tear "The Two Correct Command Families" into three fragments,
 * so a section fetch would return a piece of an argument instead of the argument.
 *
 * Text before the first heading becomes an `(intro)` section, so nothing is lost.
 */
export function splitSections(body: string): readonly KnowledgeSection[] {
  const trimmed = body.trim();
  if (!trimmed) return [];

  const lines = trimmed.split("\n");
  const headings = findHeadings(lines);
  if (headings.length === 0) return [{ heading: INTRO_HEADING, body: trimmed }];

  const topDepth = Math.min(...headings.map((h) => h.depth));
  const tops = headings.filter((h) => h.depth === topDepth);

  const intro = lines.slice(0, tops[0].line).join("\n").trim();
  const sections = tops.map((heading, i) => ({
    heading: heading.text,
    body: lines
      .slice(heading.line + 1, tops[i + 1]?.line ?? lines.length)
      .join("\n")
      .trim(),
  }));

  return intro ? [{ heading: INTRO_HEADING, body: intro }, ...sections] : sections;
}

// ---------------------------------------------------------------------------
// Summary derivation
// ---------------------------------------------------------------------------

/** Collapse all whitespace to single spaces — a summary must fit one table cell. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Clip to SUMMARY_MAX_CHARS, marking the cut so a truncated summary never reads as complete. */
function clip(text: string): string {
  return text.length <= SUMMARY_MAX_CHARS ? text : `${text.slice(0, SUMMARY_MAX_CHARS).trim()}…`;
}

/** Find a section by exact (case-insensitive) heading. */
function section(
  sections: readonly KnowledgeSection[],
  heading: string,
): KnowledgeSection | undefined {
  return sections.find((s) => s.heading.toLowerCase() === heading.toLowerCase());
}

/**
 * A playbook's card IS its Symptoms list — that is the natural retrieval trigger, and
 * the rest of the document (Detection, Root Cause, Remediation) is what the read returns.
 */
function symptomsSummary(sections: readonly KnowledgeSection[]): string | undefined {
  const symptoms = section(sections, "Symptoms");
  if (!symptoms) return undefined;
  const bullets = symptoms.body
    .split(/\n(?=[-*]\s)/)
    .map((b) => oneLine(b.replace(/^[-*]\s+/, "")))
    .filter(Boolean);
  return bullets.length > 0 ? clip(bullets.join("; ")) : undefined;
}

/** First sentence of an Overview section, for a reference with no authored summary. */
function overviewSummary(sections: readonly KnowledgeSection[]): string | undefined {
  const overview = section(sections, "Overview");
  if (!overview) return undefined;
  const prose = oneLine(overview.body);
  if (!prose) return undefined;
  const [first] = prose.split(/(?<=[.!?])\s/);
  return clip(first || prose);
}

/**
 * Resolve the one-line summary a card renders.
 *
 * The authored `summary` always wins; the derivations exist so a hand-written test
 * fixture still renders a sensible card. A real on-demand reference that reaches the
 * fallback is a corpus-lint failure (see corpus.test.ts), not a runtime problem.
 */
function deriveSummary(doc: Playbook | Reference, sections: readonly KnowledgeSection[]): string {
  if (doc.summary) return oneLine(doc.summary);
  return symptomsSummary(sections) ?? overviewSummary(sections) ?? oneLine(doc.title);
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** True when the document carries a playbook's severity field. */
function isPlaybook(doc: Playbook | Reference): doc is Playbook {
  return typeof (doc as Playbook).severity === "string";
}

/**
 * Resolve every derived field of a knowledge document.
 *
 * Idempotent in the fields the loaders already set (`id`, `kind`), so calling it on
 * loader output and on a bare test fixture produces the same shape.
 */
export function normalizeDoc(doc: Playbook | Reference): KnowledgeDoc {
  const sections = doc.sections ?? splitSections(doc.body);

  return {
    id: doc.id ?? doc.filename.replace(/\.md$/, ""),
    kind: doc.kind ?? (isPlaybook(doc) ? "playbook" : "reference"),
    title: doc.title,
    category: doc.category,
    keywords: doc.keywords,
    body: doc.body,
    filename: doc.filename,
    summary: deriveSummary(doc, sections),
    readWhen: doc.readWhen ? oneLine(doc.readWhen) : "",
    disclosure: doc.disclosure ?? "on-demand",
    sections,
    ...(isPlaybook(doc) ? { severity: doc.severity } : {}),
    tokens: estimateTokens(doc.body),
  };
}
