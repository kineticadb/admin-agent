/**
 * Bundle tool barrel — integration point for the offline-mode file-backed tools.
 *
 * Exports:
 *   BUNDLE_TOOL_NAMES       — as-const tuple of the bundle tool names
 *   makeBundleTools(holder)  — array of MCP tool objects bound to a BundleHolder
 *   createBundleRegistry()   — approval registry with all bundle tools read-only
 *
 * The tools bind to a BundleHolder (a lazy ref), NOT a BundleSource directly, so
 * they can be registered before a bundle exists and a live session can attach one
 * mid-conversation via kinetica_load_bundle. Until a bundle is loaded, the data
 * tools return a polite "no bundle loaded" failure.
 *
 * Every handler runs through the shared applyOutputPipeline (format → truncate),
 * the same contract as the live diagnostic tools, and is annotated readOnly:true.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";

import { createRegistry } from "../../approval/registry.js";
import type { Registry } from "../../approval/registry.js";
import { applyOutputPipeline } from "../index.js";
import type { BundleSource } from "../../bundle/BundleSource.js";
import type { BundleHolder } from "../../bundle/bundle-holder.js";
import type { ToolResult } from "../../types/index.js";

import { bundleListFiles, BundleListFilesSchema } from "./list-files.js";
import { bundleLogTimeline, BundleLogTimelineSchema } from "./log-timeline.js";
import { bundleSearchLogs, BundleSearchLogsSchema } from "./search-logs.js";
import { bundleReadConfig, BundleReadConfigSchema } from "./read-config.js";
import { bundleReadSysinfo, BundleReadSysinfoSchema } from "./read-sysinfo.js";
import {
  bundleLoad,
  BundleLoadSchema,
  type PromptForPath,
  type ConfirmPath,
} from "./load-bundle.js";

/** Optional interactive dependencies injected into the bundle tools. */
export interface BundleToolDeps {
  /** Directory picker used by kinetica_load_bundle when called without a path. */
  readonly promptForPath?: PromptForPath;
  /** Operator confirmation for a MODEL-supplied bundle path (widens the read surface). */
  readonly confirmPath?: ConfirmPath;
}

export const BUNDLE_TOOL_NAMES = [
  "kinetica_load_bundle",
  "kinetica_bundle_list_files",
  "kinetica_bundle_log_timeline",
  "kinetica_bundle_search_logs",
  "kinetica_bundle_read_config",
  "kinetica_bundle_read_sysinfo",
] as const;

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/** Failure returned by data tools when no bundle has been attached yet. */
function notLoaded(): ToolResult<never> {
  return {
    ok: false,
    status: 0,
    error:
      "No support bundle is loaded. Ask the operator for the extracted bundle directory path and call kinetica_load_bundle first.",
    raw: "",
  };
}

/**
 * Run a data-tool handler against the attached bundle, or return the not-loaded
 * failure. Centralizes the holder check so every tool behaves identically.
 */
async function withSource(
  holder: BundleHolder,
  fn: (source: BundleSource) => Promise<ToolResult<unknown>>,
): Promise<string> {
  const source = holder.get();
  if (!source) return applyOutputPipeline(notLoaded());
  return applyOutputPipeline(await fn(source));
}

function makeLoadBundleTool(holder: BundleHolder, deps?: BundleToolDeps) {
  return tool(
    "kinetica_load_bundle",
    "Attach an extracted Kinetica support bundle (gpudb_sysinfo directory) so the kinetica_bundle_* tools can read its logs/config/host-diagnostics. When the operator wants to analyze a support bundle, call this tool WITHOUT a path — they will be shown an interactive directory picker to choose it. Do NOT ask for the path in chat. (You may pass an explicit `path` if the operator already gave you one; it must be a directory, not a .tgz.)",
    BundleLoadSchema.shape,
    async (args: { path?: string }) =>
      text(
        applyOutputPipeline(await bundleLoad(holder, args, deps?.promptForPath, deps?.confirmPath)),
      ),
    { annotations: { readOnly: true } },
  );
}

function makeListFilesTool(holder: BundleHolder) {
  return tool(
    "kinetica_bundle_list_files",
    "Inventory the attached support bundle: detected GPUdb version, ranks present (numeric ranks only), services present (e.g. host-manager — a singleton service, NOT a rank), file counts/sizes by kind, and how many collection commands failed. Each file row includes a `description` of what it contains (e.g. mem.txt → memory/THP, gpu.txt → nvidia-smi) so you can pick the right file without reading it. Call this FIRST after a bundle is attached. Optional `kind` filters the file list (e.g. core-log, component-log, config, os-diag).",
    BundleListFilesSchema.shape,
    async (args: { kind?: string }) =>
      text(await withSource(holder, (s) => bundleListFiles(s, args))),
    { annotations: { readOnly: true } },
  );
}

function makeLogTimelineTool(holder: BundleHolder) {
  return tool(
    "kinetica_bundle_log_timeline",
    "Aggregate bundle log lines into per-time-bucket severity counts across ranks — the incident shape. Call this BEFORE search_logs to find WHEN errors spiked, then drill in with a tight time window. Defaults: min_severity=WARN, granularity=hour, core logs (all ranks AND the host manager). Narrow with rank=<r0|r1|…> (numeric ranks only) or host_manager=true for the host-manager log (a service, not a rank). Set include_components=true or component=<name> to include component logs. Note severity order is WARN < UERR < ERROR < FATAL, so min_severity=ERROR EXCLUDES UERR (user-error) lines — use UERR or WARN to include them.",
    BundleLogTimelineSchema.shape,
    async (args) => text(await withSource(holder, (s) => bundleLogTimeline(s, args))),
    { annotations: { readOnly: true } },
  );
}

function makeSearchLogsTool(holder: BundleHolder) {
  return tool(
    "kinetica_bundle_search_logs",
    "Search bundle logs for matching lines by regex (case-insensitive), min_severity, time window (from_ts/to_ts as 'YYYY-MM-DD HH:MM:SS.mmm'; a partial prefix like a timeline bucket label '2026-06-11 15' also works — it is widened to cover that whole period), and rank/host_manager/component. Streamed and bounded — the default 200-match cap is shared across all files; when capped, narrow the query (the total may be a lower bound). Defaults to core logs across all ranks AND the host manager; narrow with rank=<r0|r1|…> (numeric ranks only) or host_manager=true for the host-manager log (a service, not a rank); set component or include_components for component logs. Severity order is WARN < UERR < ERROR < FATAL, so min_severity=ERROR EXCLUDES UERR (user-error) lines.",
    BundleSearchLogsSchema.shape,
    async (args) => text(await withSource(holder, (s) => bundleSearchLogs(s, args))),
    { annotations: { readOnly: true } },
  );
}

function makeReadConfigTool(holder: BundleHolder) {
  return tool(
    "kinetica_bundle_read_config",
    "Read gpudb.conf from the attached bundle (the real on-disk config). Optionally filter by `section` (exact, case-insensitive) and/or `key` (substring, case-insensitive). Interpolation references like ${gaia.host0.address} are returned verbatim.",
    BundleReadConfigSchema.shape,
    async (args) => text(await withSource(holder, (s) => bundleReadConfig(s, args))),
    { annotations: { readOnly: true } },
  );
}

function makeReadSysinfoTool(holder: BundleHolder) {
  return tool(
    "kinetica_bundle_read_sysinfo",
    "Read an OS-diagnostic / process / version file's command blocks by name (e.g. mem.txt, cpu.txt, disk.txt, gpu.txt, net.txt, ps.txt, gpudb.txt, gpudb-exe-r0-*.txt). Returns each wrapped shell command and its output — host-level facts (memory, GPU, disk, THP, process args) the live endpoints never expose.",
    BundleReadSysinfoSchema.shape,
    async (args: { name: string }) =>
      text(await withSource(holder, (s) => bundleReadSysinfo(s, args))),
    { annotations: { readOnly: true } },
  );
}

export function makeBundleTools(holder: BundleHolder, deps?: BundleToolDeps) {
  return [
    makeLoadBundleTool(holder, deps),
    makeListFilesTool(holder),
    makeLogTimelineTool(holder),
    makeSearchLogsTool(holder),
    makeReadConfigTool(holder),
    makeReadSysinfoTool(holder),
  ];
}

/** Approval registry with every bundle tool registered read-only (defense in depth). */
export function createBundleRegistry(): Registry {
  return BUNDLE_TOOL_NAMES.reduce(
    (registry, name) => registry.registerReadOnlyTool(name),
    createRegistry(),
  );
}
