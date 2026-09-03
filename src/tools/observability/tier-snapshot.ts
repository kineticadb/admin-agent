/**
 * tierSnapshot — per-rank, per-tier storage utilization with an eviction verdict.
 *
 * One range query over `ki_db_tier`, regrouped into a row per rank+tier. Semantics
 * measured on a live 7.2.3.20 cluster, each of which reads like a trap:
 *   - `size_bytes` is the tier LIMIT, not current size; -1 means uncapped, so a
 *     percentage of it reads as "plenty of room".
 *   - watermarks are FRACTIONS of the limit (0.9/0.8), not byte counts — so eviction
 *     starts at high_watermark x size_bytes, and that distance is the real headroom.
 *   - rank 0 reports only size/used: no watermarks or eviction counters. Absent, not 0.
 *   - `evictions_total` is cumulative since start: non-zero means HAS evicted, not IS.
 *
 * Never throws.
 */

import { z } from "zod";
import type { ToolResult } from "../../types/index.js";
import type { ObservabilityClient } from "../../observability/ObservabilityClient.js";
import {
  summarizeSeries,
  formatBytesBase1000,
  type SeriesSummary,
} from "../rest/summarize-timeseries.js";
import { hhmmss, describeWindow } from "./series-rows.js";
import { readPromBody } from "./response-body.js";

/** Coarse step: this tool needs current + peak, not curve shape. */
const SNAPSHOT_STEPS = 60;
const DEFAULT_MINUTES_BACK = 60;
/** Utilization at which a tier is called "pressure" before the watermark is reached. */
const PRESSURE_FRACTION = 0.75;
/** Rendered when a value is genuinely absent — never conflated with zero. */
const ABSENT = "—";

export const TierSnapshotSchema = z.object({
  tier: z
    .string()
    .optional()
    .describe('Restrict to one tier, e.g. "ram", "disk0", "persist", "vram.gpu0". Omit for all.'),
  rank: z.string().optional().describe('Restrict to one rank, e.g. "rank0". Omit for all ranks.'),
  minutes_back: z
    .number()
    .int()
    .positive()
    .max(10080)
    .optional()
    .describe("Window used for the peak column (default 60 minutes)."),
});

export type TierSnapshotInput = z.infer<typeof TierSnapshotSchema>;

/** One rank+tier, with derived headroom and a verdict. */
export type TierRow = {
  readonly rank: string;
  readonly tier: string;
  readonly used: string;
  readonly limit: string;
  readonly used_pct: string;
  readonly peak: string;
  readonly peak_at: string;
  readonly unevictable: string;
  readonly to_eviction: string;
  readonly evictions: string;
  readonly status: string;
};

export type TierSnapshotData = {
  readonly tiers: readonly TierRow[];
};

/** One rank+tier's `what` to summary map. */
type TierGroup = Map<string, SeriesSummary>;

/**
 * Escape a PromQL label value.
 *
 * Not a security boundary — the API is read-only — but an unescaped `"` produces
 * `{tier="ram""}`, which Prometheus rejects with an opaque parse error instead of the
 * tool reporting that the filter was malformed.
 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Build the PromQL selector from optional filters. */
function buildSelector(input: TierSnapshotInput): string {
  const matchers = [
    input.tier ? `tier="${escapeLabelValue(input.tier)}"` : undefined,
    input.rank ? `source="${escapeLabelValue(input.rank)}"` : undefined,
  ].filter(Boolean);
  return matchers.length > 0 ? `ki_db_tier{${matchers.join(",")}}` : "ki_db_tier";
}

/**
 * Regroup flat series into rank+tier buckets keyed by the `what` label.
 *
 * Builds a local Map directly rather than copying per iteration. An earlier version
 * cloned the outer Map on every series while mutating the inner one already stored in
 * it — the copy bought nothing, since the shared inner Maps were mutated anyway, and
 * cost O(n^2). Neither the accumulator nor the input escapes this function.
 */
function groupByRankTier(series: readonly SeriesSummary[]): ReadonlyMap<string, TierGroup> {
  const grouped = new Map<string, TierGroup>();
  for (const s of series) {
    const { source, tier, what } = s.labels;
    if (!source || !tier || !what) continue;
    const key = `${source} ${tier}`;
    const group = grouped.get(key) ?? new Map<string, SeriesSummary>();
    group.set(what, s);
    grouped.set(key, group);
  }
  return grouped;
}

/** Latest value of one `what`, or undefined when the series is absent. */
function latest(group: TierGroup, what: string): number | undefined {
  return group.get(what)?.last;
}

/** Render a byte value, or the absent marker. */
function bytes(value: number | undefined): string {
  return value === undefined ? ABSENT : formatBytesBase1000(value);
}

/**
 * Verdict for one tier. Says nothing about eviction HISTORY: `evictions_total` is
 * cumulative, so folding it in would flag a tier that evicted an hour ago as unhealthy.
 * A MISSING size_bytes is "unknown", not "uncapped" — a scrape gap must not read as
 * "unlimited, not a problem".
 */
function verdict(
  used: number | undefined,
  limit: number | undefined,
  highWm: number | undefined,
): string {
  if (limit === undefined) return "unknown";
  if (limit <= 0) return "uncapped";
  if (used === undefined) return "unknown";
  const fraction = used / limit;
  if (highWm !== undefined && fraction >= highWm) return "over high-watermark";
  if (fraction >= PRESSURE_FRACTION) return "pressure";
  return "ok";
}

/** Build one output row from a rank+tier group. */
function toRow(key: string, group: TierGroup): TierRow {
  // Split on the FIRST space only. `source` never contains one, but destructuring
  // `key.split(" ")` would silently truncate any tier name that did.
  const sep = key.indexOf(" ");
  const rank = key.slice(0, sep);
  const tier = key.slice(sep + 1);
  const used = latest(group, "used_bytes");
  const limit = latest(group, "size_bytes");
  const highWm = latest(group, "high_watermark");
  const usedSeries = group.get("used_bytes");
  const capped = limit !== undefined && limit > 0;

  // Eviction begins at highWm x limit. Below that is the operator's real headroom.
  const trigger = capped && highWm !== undefined ? highWm * limit : undefined;
  const toEviction = trigger !== undefined && used !== undefined ? trigger - used : undefined;

  return {
    rank,
    tier,
    used: bytes(used),
    limit: capped ? formatBytesBase1000(limit) : limit === undefined ? ABSENT : "uncapped",
    used_pct: capped && used !== undefined ? `${((used / limit) * 100).toFixed(1)}%` : ABSENT,
    peak: bytes(usedSeries?.max),
    peak_at: usedSeries ? hhmmss(usedSeries.maxAt) : ABSENT,
    unevictable: bytes(latest(group, "unevictable_bytes")),
    to_eviction: toEviction === undefined ? ABSENT : formatBytesBase1000(toEviction),
    evictions: latest(group, "evictions_total")?.toString() ?? ABSENT,
    status: verdict(used, limit, highWm),
  };
}

/** Note flagging tiers that have evicted, since status reports current state only. */
function evictionNote(series: readonly SeriesSummary[]): string {
  const evicted = series.filter((s) => s.labels.what === "evictions_total" && s.last > 0);
  if (evicted.length === 0) return "";
  const who = evicted.map((s) => `${s.labels.source}/${s.labels.tier}=${s.last}`).join(", ");
  return `Cumulative evictions since process start (NOT necessarily current): ${who}.`;
}

/**
 * Snapshot storage tier utilization across ranks.
 *
 * @param client - configured observability client
 * @param input  - validated tool input
 */
export async function tierSnapshot(
  client: ObservabilityClient,
  input: TierSnapshotInput,
): Promise<ToolResult<TierSnapshotData>> {
  const end = Math.floor(Date.now() / 1000);
  const windowSeconds = (input.minutes_back ?? DEFAULT_MINUTES_BACK) * 60;
  const start = end - windowSeconds;
  const step = Math.max(10, Math.ceil(windowSeconds / SNAPSHOT_STEPS));

  try {
    const decoded = await readPromBody(
      await client.promRange(buildSelector(input), start, end, step),
    );
    if (!decoded.ok) return decoded;

    const series = summarizeSeries(decoded.body);
    const grouped = groupByRankTier(series);
    const tiers = [...grouped.entries()]
      .map(([key, group]) => toRow(key, group))
      .sort((a, b) => a.rank.localeCompare(b.rank) || a.tier.localeCompare(b.tier));

    if (tiers.length === 0) {
      return {
        ok: true,
        data: { tiers: [] },
        rowCount: 0,
        note: "No ki_db_tier series returned. Check that the stats server is running and that the tier/rank filter matches.",
      };
    }

    return {
      ok: true,
      data: { tiers },
      rowCount: tiers.length,
      note: [
        describeWindow(start, end, step),
        "size_bytes is the tier LIMIT; to_eviction is bytes until the high watermark (a fraction of the limit) is reached.",
        evictionNote(series),
      ]
        .filter(Boolean)
        .join(" "),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
      raw: "",
    };
  }
}
