/**
 * Knowledge tool barrel — the corpus reader.
 *
 * Registered in EVERY session (live, bundle-only, degraded): knowledge is
 * capability-agnostic, and the SDK fixes the tool set at query() creation, so a
 * conditionally registered tool could never appear later.
 *
 * There is deliberately no catalog.ts typecheck guard here, unlike tools/bundle/ and
 * tools/observability/. That pattern exists to render the prompt's Evidence Checklist
 * table; this tool's prompt surface is the Knowledge Library section, which is built
 * from the store itself and so cannot fall out of sync. Add one if a second knowledge
 * tool (e.g. search) ever appears.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";

import { createRegistry } from "../../approval/registry.js";
import type { Registry } from "../../approval/registry.js";
import type { KnowledgeStore } from "../../knowledge/KnowledgeStore.js";
import {
  readKnowledge,
  renderKnowledgeResult,
  KnowledgeReadSchema,
  type KnowledgeReadInput,
} from "./read-knowledge.js";

export const KNOWLEDGE_TOOL_NAMES = ["kinetica_knowledge_read"] as const;

export type KnowledgeToolName = (typeof KNOWLEDGE_TOOL_NAMES)[number];

const KNOWLEDGE_READ_DESCRIPTION =
  "Read one document from the Kinetica knowledge library by id — a diagnostic playbook (symptoms → detection → root cause → remediation) or a reference (gpudb.conf, ki_catalog schemas, SQL dialect, service commands, version quirks, support-bundle parsing). The Knowledge Library section of your instructions lists every id together with WHEN it must be read; those triggers are requirements, not suggestions. Pass 'section' to fetch one heading of a long document instead of the whole thing. Cheap and read-only: prefer reading to guessing, and call it in parallel with your other tool calls.";

/** The knowledge tools, bound to the session's store. */
export function makeKnowledgeTools(store: KnowledgeStore) {
  return [
    tool(
      "kinetica_knowledge_read",
      KNOWLEDGE_READ_DESCRIPTION,
      KnowledgeReadSchema.shape,
      // Async only to satisfy the SDK's handler signature — the read is pure and
      // synchronous; the corpus is already in memory.
      (args: KnowledgeReadInput) =>
        Promise.resolve({
          content: [
            { type: "text" as const, text: renderKnowledgeResult(readKnowledge(store, args)) },
          ],
        }),
      { annotations: { readOnly: true } },
    ),
  ];
}

/** Approval registry with every knowledge tool marked read-only. */
export function createKnowledgeRegistry(): Registry {
  return KNOWLEDGE_TOOL_NAMES.reduce(
    (registry, name) => registry.registerReadOnlyTool(name),
    createRegistry(),
  );
}

export { readKnowledge, renderKnowledgeResult, KnowledgeReadSchema, type KnowledgeReadInput };
