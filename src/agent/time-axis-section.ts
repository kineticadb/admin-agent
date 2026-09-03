/**
 * buildTimeAxisSection — the One Time Axis rule, shared by both prompt builders.
 *
 * The rule is identical everywhere; only the roster of clocks differs. Shared for the
 * reason buildObservabilitySection is: written inline in both builders it drifted on the
 * commit that added it, with separate tests pinning each variant.
 *
 * The stats-stack clause is gated on the endpoint actually reached — claiming UTC output
 * for a tool the agent cannot call. Pure.
 */

import type { ObservabilityClient } from "../observability/ObservabilityClient.js";

/** Backtick, matching the prompt builders' local convention. */
const t = "`";

/** The invariant — a claim about the agent's reasoning, so stated rather than enforced. */
const RULES = [
  `- Never state that two events from different clocks are simultaneous, or order them, unless both are UTC or the offset between those clocks is known.`,
  `- When the offset is unknown, cite each stamp with its zone and record the missing offset as an Evidence Gap — do not guess.`,
  `- The report's Timeline section is the one place events share an axis, and that axis is UTC.`,
].join("\n");

/** Bundle tools are always registered, so this is named in every context. */
const BUNDLE_CLOCKS = `A bundle's two log families disagree: rolling logs (${t}logs-local/${t}) carry host-local wall time with no zone marker, while Loki tails (${t}logs/${t}) carry UTC. The bundle does not record the host's UTC offset, so it cannot be derived from the evidence. ${t}kinetica_bundle_search_logs${t} and ${t}kinetica_bundle_log_timeline${t} report ${t}timestamp_zone${t} and warn when one result mixes both.`;

/** Which live sources render times, and in what zone. */
function liveClocks(observability: ObservabilityClient | undefined): string {
  const stack = [
    observability?.promUrl ? "Prometheus" : undefined,
    observability?.lokiUrl ? "Loki" : undefined,
  ].filter((s): s is string => s !== undefined);

  const statsClause =
    stack.length > 0 ? ` ${stack.join(" and ")} tool output is rendered in UTC.` : "";
  return `Live alert timestamps (${t}kinetica_cluster_status${t}) are shown exactly as the server sent them, in a zone the endpoint does not state.${statsClause}`;
}

/**
 * @param context       - "live" adds the live clocks; "bundle" is bundle-only
 * @param observability - reachable stats stack, gating the Prometheus/Loki claim
 */
export function buildTimeAxisSection(
  context: "live" | "bundle",
  observability?: ObservabilityClient,
): string {
  const sources =
    context === "live" ? `${liveClocks(observability)} ${BUNDLE_CLOCKS}` : BUNDLE_CLOCKS;

  return `### One Time Axis

Evidence sources keep different clocks. ${sources}

${RULES}`;
}
