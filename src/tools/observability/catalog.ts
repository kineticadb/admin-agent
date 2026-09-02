/**
 * Observability tool catalog — a SEPARATE compile-time guard for the metrics/events tools.
 *
 * Deliberately independent of the live TOOL_CATALOG / ToolName union, for the same reason
 * the bundle catalog is: these tools depend on a Prometheus/Loki endpoint rather than a
 * KineticaSession, so they must never leak into the live diagnostic tool set or its
 * allow-list. As with the other catalogs, `Record<ObservabilityToolName, ...>` means
 * adding a name to OBSERVABILITY_TOOL_NAMES without an entry here fails typecheck.
 */

import { OBSERVABILITY_TOOL_NAMES } from "./index.js";
import type { ToolCatalogEntry } from "../catalog.js";

export type ObservabilityToolName = (typeof OBSERVABILITY_TOOL_NAMES)[number];

export const OBSERVABILITY_TOOL_CATALOG: Readonly<Record<ObservabilityToolName, ToolCatalogEntry>> =
  {
    kinetica_tier_snapshot: {
      reveals:
        "Every rank+tier at once: used vs limit, peak and when, unevictable bytes, headroom to the eviction watermark, eviction count, verdict",
      whenToUse: "First move for memory/tier pressure, OOM, eviction, capacity questions",
    },
    kinetica_prom_query: {
      reveals:
        "Arbitrary PromQL over time — including host CPU/mem/disk/NUMA/swap and per-process oom_score, which no other tool can reach",
      whenToUse: "Time-shape questions, host-level pressure, anything tier_snapshot omits",
    },
    kinetica_loki_query: {
      reveals:
        "Structured DB events: per-statement SQL telemetry (jobid/user/resource_group/elapsed), request failures with attribution, rank status transitions, config and mode changes",
      whenToUse: "Query contention, who ran what, when a rank changed state, recent errors",
    },
  };

/**
 * Render the evidence checklist.
 *
 * @param names - which tools to list. Defaults to all; callers pass only the ones whose
 *   endpoint is actually reachable, so a partial stack never advertises a tool that can
 *   only return "not configured".
 */
export function buildObservabilityEvidenceChecklist(
  names: readonly ObservabilityToolName[] = OBSERVABILITY_TOOL_NAMES,
): string {
  const rows = names.map((name) => {
    const entry = OBSERVABILITY_TOOL_CATALOG[name];
    return `| ${name} | ${entry.reveals} | ${entry.whenToUse} |`;
  });

  return [
    "| Tool | What it reveals | When to use |",
    "|------|----------------|-------------|",
    ...rows,
  ].join("\n");
}
