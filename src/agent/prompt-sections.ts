/**
 * Shared system-prompt section builders.
 *
 * Extracted so both the live builder (system-prompt.ts) and the offline builder
 * (bundle-system-prompt.ts) can format playbooks and references identically
 * without importing one another (which would couple them and break test mocks).
 *
 * Pure functions — return a new string, never mutate input.
 */

import type { Playbook, Reference } from "../types/index.js";

/**
 * Format loaded playbooks into the "Common Failure Patterns" prompt section.
 * Each playbook's title becomes a bold heading, followed by its markdown body.
 * Returns empty string when no playbooks are available.
 */
export function buildFailurePatternsSection(playbooks?: readonly Playbook[]): string {
  if (!playbooks || playbooks.length === 0) return "";

  const entries = playbooks.map((p) => `**${p.title}:**\n\n${p.body}`).join("\n\n");

  return `### Common Failure Patterns\n\n${entries}`;
}

/**
 * Format loaded references into the "Reference Knowledge" prompt section.
 * Each reference's title becomes a bold heading, followed by its markdown body.
 * Returns empty string when no references are available.
 */
export function buildReferenceSection(references?: readonly Reference[]): string {
  if (!references || references.length === 0) return "";

  const entries = references.map((r) => `**${r.title}:**\n\n${r.body}`).join("\n\n");

  return `### Reference Knowledge\n\n${entries}`;
}
