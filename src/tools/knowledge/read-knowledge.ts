/**
 * kinetica_knowledge_read — serve one knowledge document, or one section of it.
 *
 * The Level-2 half of the corpus's progressive disclosure: the system prompt carries a
 * one-row card per document (id, what it covers, WHEN it must be read), and this tool
 * delivers the body when a card's trigger fires.
 *
 * Rendering deliberately splits the two paths (see renderKnowledgeResult): a FAILURE
 * goes through the shared applyOutputPipeline so errors read like every other tool's,
 * but a SUCCESS is composed by hand, because the pipeline ends in truncateOutput —
 * head 150 + tail 50 lines — which would silently delete the middle of any document
 * over 200 lines. gpudb-conf.md is already 165. Document size is bounded at load
 * instead, by MAX_DOC_TOKENS.
 *
 * Pure: no I/O, no throwing. The corpus is already in memory.
 */

import { z } from "zod";

import { applyOutputPipeline } from "../index.js";
import type { KnowledgeStore } from "../../knowledge/KnowledgeStore.js";
import type { KnowledgeDoc, ToolResult } from "../../types/index.js";

export const KnowledgeReadSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      "Document id — the filename stem listed in the Knowledge Library section of your instructions, e.g. 'gpudb-conf' or 'memory-pressure'. A '.md' suffix is accepted.",
    ),
  section: z
    .string()
    .optional()
    .describe(
      "Optional: fetch only one section instead of the whole document. Matches a '##'/'###' heading, case-insensitively, by substring — e.g. 'WAL' or 'tiered storage'. Use this on long documents whose card lists their sections.",
    ),
});

export type KnowledgeReadInput = z.infer<typeof KnowledgeReadSchema>;

/** Join section headings for a note or an error, in document order. */
function headingList(doc: KnowledgeDoc): string {
  return doc.sections.map((s) => s.heading).join("; ");
}

/** Available ids, grouped by kind, for the unknown-id failure. */
function availableIds(store: KnowledgeStore): string {
  const kinds: readonly KnowledgeDoc["kind"][] = ["playbook", "reference", "bundle-reference"];
  return kinds
    .map((kind) => ({
      kind,
      ids: store
        .list()
        .filter((d) => d.kind === kind)
        .map((d) => d.id),
    }))
    .filter(({ ids }) => ids.length > 0)
    .map(({ kind, ids }) => `${kind}: ${ids.join(", ")}`)
    .join(" | ");
}

/**
 * Read a document, or one of its sections.
 *
 * A section miss returns the section list rather than falling back to the whole body:
 * the agent asked for less, so handing it everything ignores the request and spends
 * the context the `section` parameter exists to save.
 */
export function readKnowledge(
  store: KnowledgeStore,
  input: KnowledgeReadInput,
): ToolResult<string> {
  const doc = store.get(input.id);
  if (!doc) {
    const ids = availableIds(store);
    return {
      ok: false,
      status: 0,
      error: ids
        ? `No knowledge document "${input.id}". Available ids — ${ids}.`
        : `No knowledge document "${input.id}": this session has no knowledge documents loaded.`,
      raw: "",
    };
  }

  if (input.section === undefined) {
    return {
      ok: true,
      data: doc.body,
      note:
        `${doc.title} — ${doc.kind}, ~${doc.tokens} tokens. Sections: ${headingList(doc)}. ` +
        `Cite this document by id ("${doc.id}") under Evidence Collected.`,
    };
  }

  const section = store.getSection(doc.id, input.section);
  if (!section) {
    return {
      ok: false,
      status: 0,
      error: `No section matching "${input.section}" in "${doc.id}". Sections: ${headingList(doc)}.`,
      raw: "",
    };
  }

  return {
    ok: true,
    data: section.body,
    note:
      `${doc.title} § ${section.heading} — ${doc.kind}. Other sections: ${headingList(doc)}. ` +
      `Cite this document by id ("${doc.id}") under Evidence Collected.`,
  };
}

/**
 * Render a knowledge result for the model.
 *
 * Note first so it survives any downstream clipping, then the authored markdown
 * verbatim — no reshaping (it is already markdown) and no truncation (see the module
 * header). Failures fall back to the shared pipeline for consistency with every
 * other tool's error output.
 */
export function renderKnowledgeResult(result: ToolResult<string>): string {
  if (!result.ok) return applyOutputPipeline(result);
  return result.note ? `${result.note}\n\n${result.data}` : result.data;
}
