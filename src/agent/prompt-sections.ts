/**
 * Shared system-prompt section builders.
 *
 * Extracted so both the live builder (system-prompt.ts) and the offline builder
 * (bundle-system-prompt.ts) can format playbooks and references identically
 * without importing one another (which would couple them and break test mocks).
 *
 * Progressive disclosure lives here. Each document renders one of two ways, chosen by
 * its frontmatter `disclosure`:
 *
 *   inline    — the full body, exactly as before. Reserved for policy the agent must
 *               obey WITHOUT knowing to look it up (today: mutation-safety).
 *   on-demand — one card row: id, what it covers, and WHEN it must be read. The body
 *               arrives through kinetica_knowledge_read when the trigger fires.
 *
 * Every card states an UNCONDITIONAL, phase-anchored trigger ("before writing ANY
 * SQL, read sql-dialect"), never a topical hint ("useful for SQL questions"). This
 * repo has measured the difference: a capability the prompt describes conditionally
 * is a capability the agent does not use — it skipped the entire Loki log dimension
 * on a live cluster because the prompt framed it as probably-unavailable. Retrieval
 * tied to a protocol step the agent is already executing happens; retrieval that
 * depends on the model noticing relevance does not.
 *
 * Pure functions — return a new string, never mutate input.
 */

import { normalizeDoc } from "../knowledge/normalize-doc.js";
import type { KnowledgeDoc, Playbook, Reference } from "../types/index.js";

/**
 * Above this size a card also lists the document's sections, so the agent can fetch
 * one heading instead of the whole thing. Below it, the section list is noise.
 */
const SECTION_LIST_MIN_TOKENS = 2_000;

/** Backtick helper — matches the prompt builders' own escaping of literals. */
const t = "`";

// ---------------------------------------------------------------------------
// Cell rendering
// ---------------------------------------------------------------------------

/** Make arbitrary authored text safe for one markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/** Render a markdown table from a header row and body rows. */
function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${headers.join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  return [head, rule, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

/** A document rendered in full, in the pre-disclosure format the inline tier keeps. */
function inlineBody(doc: KnowledgeDoc): string {
  return `**${doc.title}:**\n\n${doc.body}`;
}

/**
 * The "covers" cell: what the document holds, plus its section list when it is long
 * enough that reading one heading beats reading all of it.
 */
function covers(doc: KnowledgeDoc): string {
  const sections =
    doc.tokens > SECTION_LIST_MIN_TOKENS
      ? ` Sections: ${doc.sections.map((s) => s.heading).join("; ")}.`
      : "";
  return cell(`${doc.summary}${sections}`);
}

/** Split documents into the two rendering tiers, honouring a forced override. */
function partition(
  docs: readonly KnowledgeDoc[],
  forceInline: boolean,
): { readonly cards: readonly KnowledgeDoc[]; readonly bodies: readonly KnowledgeDoc[] } {
  if (forceInline) return { cards: [], bodies: docs };
  return {
    cards: docs.filter((d) => d.disclosure === "on-demand"),
    bodies: docs.filter((d) => d.disclosure === "inline"),
  };
}

/** Join the rendered parts of a section, dropping the empty ones. */
function section(heading: string, parts: readonly string[]): string {
  const body = parts.filter(Boolean).join("\n\n");
  return body ? `${heading}\n\n${body}` : "";
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/**
 * Format loaded playbooks into the "Common Failure Patterns" prompt section.
 *
 * An on-demand playbook's card IS its Symptoms list — the natural retrieval trigger —
 * and the body it fetches holds Detection, Root Cause and Remediation. An inline one
 * keeps the original `**Title:**` + body format.
 *
 * Returns empty string when no playbooks are available.
 */
export function buildFailurePatternsSection(playbooks?: readonly Playbook[]): string {
  if (!playbooks || playbooks.length === 0) return "";

  const { cards, bodies } = partition(playbooks.map(normalizeDoc), false);

  const cardBlock =
    cards.length > 0
      ? `Each row is one playbook's symptoms. When they match what you are seeing, read that ` +
        `playbook with ${t}kinetica_knowledge_read${t} for its Detection, Root Cause and ` +
        `Remediation — do not diagnose from the symptom line alone.\n\n` +
        table(
          ["id", "severity", "symptoms"],
          cards.map((d) => [d.id, cell(d.severity ?? "info"), cell(d.summary)]),
        )
      : "";

  return section("### Common Failure Patterns", [cardBlock, ...bodies.map(inlineBody)]);
}

/**
 * Format loaded references into the "Reference Knowledge" prompt section.
 *
 * @param opts.forceInline — render every reference in full regardless of its own
 *   disclosure. This is how the bundle references become inline once a bundle is
 *   actually attached: with a bundle as the session's subject a guaranteed read is
 *   wasted latency, while for a session that never attaches one those same 2.6k
 *   tokens of parsing detail are dead weight.
 * @param opts.heading — override the section heading. Both prompts render the bundle
 *   references separately from the general ones (they take different tiers), and two
 *   blocks under one "### Reference Knowledge" heading would read as the second
 *   superseding the first — especially now that one may be a card table and the other
 *   full text.
 *
 * Returns empty string when no references are available.
 */
export function buildReferenceSection(
  references?: readonly Reference[],
  opts?: { readonly forceInline?: boolean; readonly heading?: string },
): string {
  if (!references || references.length === 0) return "";

  const { cards, bodies } = partition(references.map(normalizeDoc), opts?.forceInline ?? false);

  const cardBlock =
    cards.length > 0
      ? `Read a document with ${t}kinetica_knowledge_read${t} when its "read when" applies. ` +
        `Those triggers are requirements, not suggestions.\n\n` +
        table(
          ["id", "covers", "read when"],
          cards.map((d) => [d.id, covers(d), cell(d.readWhen)]),
        )
      : "";

  return section(opts?.heading ?? "### Reference Knowledge", [
    cardBlock,
    ...bodies.map(inlineBody),
  ]);
}

/**
 * The "## Knowledge Library" preamble — how the tool works and what the cards oblige.
 *
 * Rendered once per prompt, immediately before the card tables. Returns "" when every
 * document is inline, so a corpus with nothing to fetch never advertises a tool the
 * agent has no reason to call.
 */
export function buildKnowledgeLibraryIntro(docs?: readonly (Playbook | Reference)[]): string {
  const onDemand = (docs ?? []).map(normalizeDoc).filter((d) => d.disclosure === "on-demand");
  if (onDemand.length === 0) return "";

  return `## Knowledge Library

${onDemand.length} documents are available as one-line cards below — id, what each covers, and when to read it. Their bodies are NOT in these instructions. Read one with ${t}kinetica_knowledge_read${t} (an ${t}id${t}, and optionally a ${t}section${t} to fetch a single heading of a long document).

- A card's **read when** is a requirement, not a suggestion. When its trigger fires, read the document BEFORE you act — never from memory of Kinetica or of another SQL dialect. Kinetica looks like PostgreSQL and differs in ways that fail at runtime.
- Reads are cheap, read-only and local. Issue them in parallel with your other tool calls; do not spend a turn asking whether to read.
- Read what the current phase requires — not the whole library. A card you have no trigger for is a card you skip.
- Name every id you read under Evidence Collected (${t}knowledge: memory-pressure, tiered-objects${t}).
- If a document you read earlier is no longer visible, this conversation was compacted. Read it again rather than working from a half-remembered rule.`;
}
