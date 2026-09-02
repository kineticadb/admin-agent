/**
 * series-rows — render summarized Prometheus series as flat table rows.
 *
 * Byte-ness is inferred from the `what` label, not the metric name, because one metric
 * mixes units: `ki_db_tier` carries used_bytes, evictions_total and high_watermark (a
 * fraction — formatting 0.9 as "0.90 B" would mislead). Base-1000 throughout, matching
 * how tier limits are configured.
 *
 * Labels identical across every series are hoisted into `common` — repeating them per row
 * measured ~150 chars of mostly-redundant text against a real cluster.
 *
 * Pure. Never throws.
 */

import { formatBytesBase1000, type SeriesSummary } from "../rest/summarize-timeseries.js";

/** One series rendered for a markdown table. */
export type SeriesRow = {
  /** Metric name (`__name__`). */
  readonly metric: string;
  /** Remaining labels as `k=v` pairs, sorted for stable diffing. */
  readonly series: string;
  readonly first: string;
  readonly min: string;
  readonly min_at: string;
  readonly max: string;
  readonly max_at: string;
  readonly last: string;
  readonly delta: string;
  readonly points: number;
};

/** How to render numeric values. `auto` infers byte-ness per series. */
export type ValueFormat = "auto" | "bytes" | "raw";

export type SeriesRowOptions = {
  readonly format?: ValueFormat;
};

/** Rows plus the labels every row shared, hoisted out of the table. */
export type SeriesRowSet = {
  readonly rows: readonly SeriesRow[];
  /** `k=v` pairs common to all series, or "" when there are none. */
  readonly common: string;
};

/**
 * Host metrics whose `what` values are byte counts without saying so in the label.
 *
 * Measured: `ki_host_mem{what="used"}` is bytes, but the label is bare `used`, so the
 * `_bytes` suffix rule misses it and a multi-gigabyte figure renders as a raw integer.
 * These metrics also carry non-byte `what` values (`ki_host_disk{what="io_time"}`,
 * `{what="reads"}`), so the metric name alone is not sufficient either — it takes the
 * pair. Anything not listed falls through to the suffix rules below.
 */
const BYTE_VALUED_HOST_METRICS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["ki_host_mem", new Set(["total", "used", "free", "cached", "buffers"])],
  ["ki_host_disk", new Set(["total", "used", "free", "size"])],
  ["ki_host_swap", new Set(["total", "used", "free"])],
]);

/**
 * True when a series' values are byte counts.
 *
 * Keys off the `what` label first — that is the unit discriminator within a metric —
 * and falls back to the metric name for metrics that carry units in the name instead
 * (e.g. `ki_db_request_received_bytes_sum`).
 */
export function isByteMetric(labels: Readonly<Record<string, string>>): boolean {
  const what = labels.what;
  const name = labels.__name__;
  if (what !== undefined) {
    if (name !== undefined && BYTE_VALUED_HOST_METRICS.get(name)?.has(what)) return true;
    return what.endsWith("_bytes");
  }
  return name?.includes("bytes") ?? false;
}

/**
 * Render a second-epoch timestamp as UTC `HH:MM:SS`, or `?` for junk.
 *
 * Finiteness alone is not enough: Date only spans +/-8.64e15 ms, and `toISOString()`
 * throws RangeError outside it. This module promises never to throw, and tier-snapshot
 * calls it per row — one absurd timestamp would abort an entire snapshot with "Invalid
 * time value" rather than degrading a single cell.
 */
export function hhmmss(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return "?";
  const ms = epochSeconds * 1000;
  if (Math.abs(ms) > 8.64e15) return "?";
  return new Date(ms).toISOString().slice(11, 19);
}

/**
 * Describe the absolute query window.
 *
 * Rows carry clock times only, which are ambiguous on their own — this note supplies the
 * date and step so `max @ 14:22:00` is interpretable. Prepended via ToolSuccess.note,
 * which survives truncation because head lines are always kept.
 */
export function describeWindow(startSec: number, endSec: number, stepSec: number): string {
  // Slice rather than replace(".000Z"): callers pass whole seconds today, but a
  // fractional timestamp would have left the milliseconds in place.
  const iso = (s: number) => `${new Date(s * 1000).toISOString().slice(0, 19)}Z`;
  return `Window: ${iso(startSec)} → ${iso(endSec)} UTC, ${stepSec}s step. Times below are UTC HH:MM:SS.`;
}

/**
 * Render a non-byte number compactly without destroying small magnitudes.
 *
 * Prometheus returns full float precision: measured `ki_host_cpu{what="idle"}` values
 * arrive as `75.20576380460521`, 18 characters where 6 carry the meaning, on every cell
 * of every row. Integers pass through untouched; values at or above 1 get 3 decimals;
 * below 1 uses 3 significant digits so a watermark fraction (0.9) and a sub-millisecond
 * duration (0.00012) both survive, where a flat toFixed(3) would round the latter to 0.
 */
function renderNumber(value: number): string {
  if (!Number.isFinite(value) || Number.isInteger(value)) return String(value);
  const fixed = Math.abs(value) >= 1 ? value.toFixed(3) : value.toPrecision(3);
  // Trim trailing zeros (and a bare trailing dot) so 0.900 reads as 0.9.
  return fixed.replace(/\.?0+$/, "");
}

/** Format one value according to the resolved format. */
function renderValue(value: number, asBytes: boolean): string {
  return asBytes ? formatBytesBase1000(value) : renderNumber(value);
}

/** Format a delta with an explicit sign, so direction of travel is unmissable. */
function renderDelta(value: number, asBytes: boolean): string {
  if (value === 0) return "0";
  const body = renderValue(Math.abs(value), asBytes);
  return `${value > 0 ? "+" : "-"}${body}`;
}

/**
 * Labels that are pure restatements of others and only cost width.
 *
 * Measured job-name format is `ki_db_ring_<ring>_cluster_<cluster>_rank_<N>` — it encodes
 * ring, cluster and rank, all of which appear as their own labels, at ~48 characters per
 * row. `instance` is `<host>:<port>`, where `host` is its own label and the port only
 * restates which rank this is. Both are dropped ONLY when `source` is present to carry
 * the rank identity, so a non-Kinetica metric keeps them.
 */
const REDUNDANT_WHEN_SOURCE_PRESENT = new Set(["job", "instance"]);

/** Render labels as sorted `k=v` pairs. */
function renderPairs(entries: readonly (readonly [string, string])[]): string {
  return [...entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

/**
 * Label keys whose value is identical across every series.
 *
 * These describe the query's context rather than distinguishing its results, so they are
 * reported once in the note instead of repeated on every row. With a single series that
 * is every label, which is the correct and most compact rendering of one series.
 */
function commonLabelKeys(series: readonly SeriesSummary[]): ReadonlySet<string> {
  if (series.length === 0) return new Set();
  const [head, ...rest] = series;
  const shared = Object.keys(head.labels).filter(
    (k) => k !== "__name__" && rest.every((s) => s.labels[k] === head.labels[k]),
  );
  return new Set(shared);
}

/**
 * Convert summarized series into flat table rows.
 *
 * @param series - output of summarizeSeries()
 * @param opts   - `format` forces byte or raw rendering; defaults to per-series inference
 */
export function toSeriesRows(
  series: readonly SeriesSummary[],
  opts?: SeriesRowOptions,
): SeriesRowSet {
  const format = opts?.format ?? "auto";
  const common = commonLabelKeys(series);

  const rows = series.map((s) => {
    const asBytes = format === "bytes" || (format === "auto" && isByteMetric(s.labels));
    const hasSource = s.labels.source !== undefined;
    const distinguishing = Object.entries(s.labels).filter(
      ([k]) =>
        k !== "__name__" && !common.has(k) && !(hasSource && REDUNDANT_WHEN_SOURCE_PRESENT.has(k)),
    );
    return {
      metric: s.labels.__name__ ?? "",
      series: renderPairs(distinguishing),
      first: renderValue(s.first, asBytes),
      min: renderValue(s.min, asBytes),
      min_at: hhmmss(s.minAt),
      max: renderValue(s.max, asBytes),
      max_at: hhmmss(s.maxAt),
      last: renderValue(s.last, asBytes),
      delta: renderDelta(s.delta, asBytes),
      points: s.points,
    };
  });

  const head = series[0];
  const commonPairs = head ? renderPairs([...common].map((k) => [k, head.labels[k]] as const)) : "";

  return { rows, common: commonPairs };
}
