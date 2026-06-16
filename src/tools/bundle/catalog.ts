/**
 * Bundle tool catalog — a SEPARATE compile-time guard for offline-mode tools.
 *
 * Deliberately independent of the live TOOL_CATALOG / ToolName union: bundle
 * tools must never leak into the live diagnostic tool sets, allow-list, or
 * evidence checklist. As with the live catalog, `Record<BundleToolName, ...>`
 * means adding a name to BUNDLE_TOOL_NAMES without an entry here fails typecheck.
 */

import { BUNDLE_TOOL_NAMES } from "./index.js";
import type { ToolCatalogEntry } from "../catalog.js";

export type BundleToolName = (typeof BUNDLE_TOOL_NAMES)[number];

export const BUNDLE_TOOL_CATALOG: Readonly<Record<BundleToolName, ToolCatalogEntry>> = {
  kinetica_load_bundle: {
    reveals: "Attaches an extracted support bundle (directory path) for offline analysis",
    whenToUse: "When the operator wants to analyze a support bundle — ask for the path, then load",
  },
  kinetica_bundle_list_files: {
    reveals: "Bundle inventory: detected version, ranks, file kinds/sizes, failed collections",
    whenToUse: "First action of every bundle investigation (orientation)",
  },
  kinetica_bundle_log_timeline: {
    reveals: "WARN+ log lines bucketed by time + severity across ranks (incident shape)",
    whenToUse: "Right after list_files — find WHEN errors spiked before drilling in",
  },
  kinetica_bundle_search_logs: {
    reveals: "Matching log lines by regex/severity/time-window/rank (bounded, streamed)",
    whenToUse: "Drill into a time window or error pattern surfaced by the timeline",
  },
  kinetica_bundle_read_config: {
    reveals: "gpudb.conf entries (the real on-disk config), filterable by section/key",
    whenToUse: "Config drift, misconfiguration, parameter verification",
  },
  kinetica_bundle_read_sysinfo: {
    reveals: "OS-diag / process / version command blocks (mem, cpu, disk, gpu, ps, gpudb.txt)",
    whenToUse: "Host-level facts: memory pressure, GPU presence, disk, THP, process args",
  },
};

export function buildBundleEvidenceChecklist(): string {
  const rows = BUNDLE_TOOL_NAMES.map((name) => {
    const entry = BUNDLE_TOOL_CATALOG[name];
    return `| ${name} | ${entry.reveals} | ${entry.whenToUse} |`;
  });

  return [
    "| Tool | What it reveals | When to use |",
    "|------|----------------|-------------|",
    ...rows,
  ].join("\n");
}
