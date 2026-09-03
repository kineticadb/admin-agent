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
import {
  commonLabelKeys,
  renderCommon,
  renderNumber,
  renderPairs,
  REDUNDANT_WHEN_SOURCE_PRESENT,
} from "./label-rows.js";

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

/** `__name__` is never hoisted: it becomes the table's own `metric` column. */
const NEVER_HOISTED: ReadonlySet<string> = new Set(["__name__"]);

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
  const common = commonLabelKeys(series, NEVER_HOISTED);

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

  return { rows, common: renderCommon(series, common) };
}
