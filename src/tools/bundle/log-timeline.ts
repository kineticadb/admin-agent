/**
 * kinetica_bundle_log_timeline — at-a-glance incident shape over bundle logs.
 *
 * Buckets WARN+ (configurable) log lines by time and counts per severity across
 * the selected ranks. The agent should call this BEFORE search_logs: it collapses
 * a multi-million-line corpus into a handful of rows that reveal when errors
 * spiked, so the subsequent search can be tightly time-windowed.
 */

import { z } from "zod";
import type { BundleSource, BundleTimelineQuery } from "../../bundle/BundleSource.js";
import type { ToolResult } from "../../types/index.js";

export const BundleLogTimelineSchema = z.object({
  min_severity: z.enum(["INFO", "WARN", "UERR", "ERROR", "FATAL"]).optional(),
  granularity: z.enum(["day", "hour", "minute"]).optional(),
  rank: z
    .string()
    .describe('Numeric rank only, e.g. "r0"/"r1". For the host manager use host_manager.')
    .optional(),
  host_manager: z
    .boolean()
    .describe("Bucket the host-manager (hm) log — a singleton service, not a rank.")
    .optional(),
  component: z.string().optional(),
  include_components: z.boolean().optional(),
});

export type BundleLogTimelineInput = z.infer<typeof BundleLogTimelineSchema>;

export async function bundleLogTimeline(
  source: BundleSource,
  args: BundleLogTimelineInput = {},
): Promise<ToolResult<unknown>> {
  const query: BundleTimelineQuery = {
    ...(args.min_severity !== undefined ? { minSeverity: args.min_severity } : {}),
    ...(args.granularity !== undefined ? { granularity: args.granularity } : {}),
    ...(args.rank !== undefined ? { rank: args.rank } : {}),
    ...(args.host_manager !== undefined ? { hostManager: args.host_manager } : {}),
    ...(args.component !== undefined ? { component: args.component } : {}),
    ...(args.include_components !== undefined
      ? { includeComponents: args.include_components }
      : {}),
  };

  const result = await source.logTimeline(query);

  // Render each bucket as a row with one column per severity seen (stable column order).
  const severities = [...new Set(result.buckets.flatMap((b) => Object.keys(b.counts)))];
  const order = ["FATAL", "ERROR", "UERR", "WARN", "INFO"];
  severities.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  const rows = result.buckets.map((b) => {
    const row: Record<string, string | number> = { time_bucket: b.bucket };
    for (const sev of severities) row[sev] = b.counts[sev] ?? 0;
    row.total = b.total;
    return row;
  });

  return {
    ok: true,
    note:
      result.totalCounted === 0
        ? "No lines at or above the severity threshold — try a lower min_severity."
        : `${result.totalCounted} event(s) across ${result.buckets.length} bucket(s), ${result.filesScanned.length} file(s).`,
    data: {
      lines_scanned: result.linesScanned,
      files_scanned: result.filesScanned.join(", ") || "none",
      buckets: rows,
    },
  };
}
