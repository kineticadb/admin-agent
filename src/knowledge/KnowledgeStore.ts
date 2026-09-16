/**
 * KnowledgeStore — the in-memory corpus the prompt renders from and the
 * kinetica_knowledge_read tool serves.
 *
 * The analogue of bundle/BundleSource.ts and observability/ObservabilityClient.ts: a
 * closure-based factory over the arrays the loaders already produce, normalizing each
 * document once so every consumer sees the same resolved shape.
 *
 * Naming caveat: `knowledge/` at the repo ROOT is the markdown corpus; `src/knowledge/`
 * is the code that serves it, and `src/tools/knowledge/` the tool that exposes it.
 *
 * Pure aside from one stderr warning for an oversize document. Never throws.
 */

import pc from "picocolors";

import { normalizeDoc, MAX_DOC_TOKENS } from "./normalize-doc.js";
import type { KnowledgeDoc, KnowledgeSection, Playbook, Reference } from "../types/index.js";

export type KnowledgeStore = {
  /** Every document, normalized, in the order supplied. */
  readonly list: () => readonly KnowledgeDoc[];
  /** Resolve by id. Tolerant of a ".md" suffix, case, and surrounding whitespace. */
  readonly get: (id: string) => KnowledgeDoc | undefined;
  /** Resolve one section of one document by heading. Exact match wins over substring. */
  readonly getSection: (id: string, heading: string) => KnowledgeSection | undefined;
  /** Documents rendered into the system prompt in full. */
  readonly inline: () => readonly KnowledgeDoc[];
  /** Documents rendered as a card, read on demand. */
  readonly onDemand: () => readonly KnowledgeDoc[];
};

/**
 * Normalize an id for lookup.
 *
 * The ".md" tolerance is what lets the existing cross-references INSIDE documents
 * ("see service-management.md") keep working with no corpus edits — the agent reads
 * that spelling and passes it straight to the tool.
 */
function normalizeId(id: string): string {
  return id.trim().toLowerCase().replace(/\.md$/, "");
}

/**
 * Warn when a document is large enough that reading it whole is wasteful.
 *
 * Names the `section` parameter as the remedy rather than suggesting the document be
 * cut down: a long reference is often correct, and fetching one heading is the fix.
 */
function warnIfOversize(doc: KnowledgeDoc): void {
  if (doc.tokens <= MAX_DOC_TOKENS) return;
  process.stderr.write(
    pc.yellow(
      `⚠ knowledge document "${doc.id}" is ~${doc.tokens} tokens (threshold ${MAX_DOC_TOKENS}) — ` +
        `reading it whole is expensive; prefer kinetica_knowledge_read with a section, or split the document.\n`,
    ),
  );
}

/**
 * Build a store over the loaded corpus.
 *
 * Takes the loaders' arrays directly (playbooks, references, bundle references
 * concatenated) so nothing has to know which list a document came from — `kind`,
 * set by the loader, already carries that.
 */
export function createKnowledgeStore(docs: readonly (Playbook | Reference)[]): KnowledgeStore {
  const normalized = docs.map(normalizeDoc);
  normalized.forEach(warnIfOversize);

  const byId = new Map(normalized.map((doc) => [normalizeId(doc.id), doc]));

  const get = (id: string): KnowledgeDoc | undefined => byId.get(normalizeId(id));

  const getSection = (id: string, heading: string): KnowledgeSection | undefined => {
    const doc = get(id);
    if (!doc) return undefined;
    const wanted = heading.trim().toLowerCase();
    // Exact first: a document with both "Rules" and "Reporting Rules" must resolve
    // "Rules" to the section actually named that, not to whichever comes first.
    return (
      doc.sections.find((s) => s.heading.toLowerCase() === wanted) ??
      doc.sections.find((s) => s.heading.toLowerCase().includes(wanted))
    );
  };

  return Object.freeze({
    list: () => normalized,
    get,
    getSection,
    inline: () => normalized.filter((d) => d.disclosure === "inline"),
    onDemand: () => normalized.filter((d) => d.disclosure === "on-demand"),
  });
}
