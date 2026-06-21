/**
 * kinetica_bundle_search_logs — streaming, filtered search over bundle logs.
 *
 * The drill-down tool: find specific log lines by regex, severity, time window,
 * and rank/component. Results are bounded (the true match count is reported even
 * when capped) so a 20 MB log never floods the context.
 */

import { z } from "zod";
import type { BundleSource, BundleLogQuery } from "../../bundle/BundleSource.js";
import type { ToolResult } from "../../types/index.js";

export const BundleSearchLogsSchema = z.object({
  regex: z.string().optional(),
  min_severity: z.enum(["INFO", "WARN", "UERR", "ERROR", "FATAL"]).optional(),
  from_ts: z.string().optional(),
  to_ts: z.string().optional(),
  rank: z
    .string()
    .describe('Numeric rank only, e.g. "r0"/"r1". For the host manager use host_manager.')
    .optional(),
  host_manager: z
    .boolean()
    .describe("Search the host-manager (hm) log — a singleton service, not a rank.")
    .optional(),
  component: z.string().optional(),
  include_components: z.boolean().optional(),
  include_multiline: z
    .boolean()
    .describe(
      "Reconstruct multi-line log records: append continuation lines (those with no " +
        "timestamp) to each match. Use this to capture a full SQL statement on an " +
        "'Executing SQL:' line — the query often spans many lines because the SQL has " +
        "embedded newlines, and a plain match shows only its first line. Works on the " +
        "rolling core logs (logs-local/); Loki per-rank tails (logs/rankN.log) keep only " +
        "the statement's first line, so there are no continuation lines to stitch there.",
    )
    .optional(),
  max_matches: z.number().int().min(1).max(1000).optional(),
});

export type BundleSearchLogsInput = z.infer<typeof BundleSearchLogsSchema>;

export async function bundleSearchLogs(
  source: BundleSource,
  args: BundleSearchLogsInput = {},
): Promise<ToolResult<unknown>> {
  const query: BundleLogQuery = {
    ...(args.regex !== undefined ? { regex: args.regex } : {}),
    ...(args.min_severity !== undefined ? { minSeverity: args.min_severity } : {}),
    ...(args.from_ts !== undefined ? { fromTs: args.from_ts } : {}),
    ...(args.to_ts !== undefined ? { toTs: args.to_ts } : {}),
    ...(args.rank !== undefined ? { rank: args.rank } : {}),
    ...(args.host_manager !== undefined ? { hostManager: args.host_manager } : {}),
    ...(args.component !== undefined ? { component: args.component } : {}),
    ...(args.include_components !== undefined
      ? { includeComponents: args.include_components }
      : {}),
    ...(args.include_multiline !== undefined ? { coalesceMultiline: args.include_multiline } : {}),
    ...(args.max_matches !== undefined ? { maxMatches: args.max_matches } : {}),
  };

  const result = await source.searchLogs(query);

  // totalMatched is the TRUE total across every scanned file; only the displayed
  // lines are capped. Say "display capped" so the count isn't read as a lower bound.
  const note = result.capped
    ? `Showing ${result.matches.length} of ${result.totalMatched} matches across ${result.filesScanned.length} file(s) (display capped). Narrow with a tighter regex, severity, or time window to surface the specific lines.`
    : `${result.totalMatched} match(es) across ${result.filesScanned.length} file(s).`;

  return {
    ok: true,
    note,
    data: {
      total_matched: result.totalMatched,
      lines_scanned: result.linesScanned,
      files_scanned: result.filesScanned.join(", ") || "none",
      capped: result.capped,
      matches: result.matches.map((m) => ({
        file: m.file,
        line: m.lineNumber,
        timestamp: m.timestamp ?? "",
        severity: m.severity ?? "",
        rank: m.rank ?? "",
        message: m.message,
      })),
    },
  };
}
