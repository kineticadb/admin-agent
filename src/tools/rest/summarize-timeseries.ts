/**
 * summarizeSeries — reduce a Prometheus response to per-series statistics.
 *
 * The time-series analogue of summarize-shards.ts: one metric over 2 ranks x 60 steps
 * measured 3,472 bytes raw and 795 summarized, and the realistic query is several times
 * that. min and max carry THEIR TIMESTAMPS — when a peak happened is usually the finding.
 *
 * Pure. Never throws, never mutates, degrades to [] on anything unexpected.
 */

/** One decoded sample: [second-epoch timestamp, numeric value]. */
export type TimeSeriesPoint = readonly [number, number];

/** Per-series reduction of a Prometheus matrix/vector result. */
export type SeriesSummary = {
  /** The series' full label set, verbatim. */
  readonly labels: Readonly<Record<string, string>>;
  /** Smallest observed value, and the timestamp it occurred at. */
  readonly min: number;
  readonly minAt: number;
  /** Largest observed value, and the timestamp it occurred at. */
  readonly max: number;
  readonly maxAt: number;
  /** First and last observed values, and the window they bound. */
  readonly first: number;
  readonly last: number;
  readonly firstTs: number;
  readonly lastTs: number;
  /** `last - first`. Zero on a flat series; sign carries direction of travel. */
  readonly delta: number;
  /** Count of valid samples in the FULL series, independent of any point cap. */
  readonly points: number;
  /** Raw samples, present only when `includePoints` was requested. */
  readonly values?: readonly TimeSeriesPoint[];
  /** True when `values` was capped at MAX_INCLUDED_POINTS. */
  readonly pointsTruncated?: boolean;
};

/** Options for summarizeSeries. */
export type SummarizeOptions = {
  /**
   * Return the raw samples alongside the summary. An escape hatch for when the agent
   * genuinely needs the shape of a curve rather than its extremes — capped, because an
   * uncapped hatch defeats the purpose of this module.
   */
  readonly includePoints?: boolean;
};

/** Hard cap on samples returned per series when `includePoints` is set. */
export const MAX_INCLUDED_POINTS = 120;

/** Extract `data.result` from a Prometheus response body, or undefined. */
function extractResult(raw: unknown): readonly unknown[] | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const data = (raw as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return undefined;
  const result = (data as { result?: unknown }).result;
  return Array.isArray(result) ? result : undefined;
}

/** Coerce a metric object into a string→string label map. */
function toLabels(metric: unknown): Readonly<Record<string, string>> | undefined {
  if (metric === null || typeof metric !== "object" || Array.isArray(metric)) return undefined;
  return Object.fromEntries(
    Object.entries(metric as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
  );
}

/**
 * Decode a `values` array into numeric points, dropping anything unparseable.
 *
 * Prometheus renders absent/undefined samples as the literal string "NaN". Coercing
 * those with Number() and keeping them would make min and max NaN for the whole series,
 * silently destroying the summary — so they are dropped and simply not counted.
 */
function toPoints(values: unknown): readonly TimeSeriesPoint[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((entry): TimeSeriesPoint[] => {
    if (!Array.isArray(entry) || entry.length < 2) return [];
    const ts = Number(entry[0]);
    const value = Number(entry[1]);
    if (!Number.isFinite(ts) || !Number.isFinite(value)) return [];
    return [[ts, value]];
  });
}

/** Reduce decoded points to their extremes. Points is known non-empty. */
function reduceExtremes(points: readonly TimeSeriesPoint[]): {
  min: number;
  minAt: number;
  max: number;
  maxAt: number;
} {
  return points.reduce(
    (acc, [ts, value]) => ({
      min: value < acc.min ? value : acc.min,
      minAt: value < acc.min ? ts : acc.minAt,
      max: value > acc.max ? value : acc.max,
      maxAt: value > acc.max ? ts : acc.maxAt,
    }),
    { min: points[0][1], minAt: points[0][0], max: points[0][1], maxAt: points[0][0] },
  );
}

/**
 * Summarize a Prometheus `query`/`query_range` response.
 *
 * @param raw  - the parsed JSON body (or anything at all — junk yields [])
 * @param opts - optional `includePoints` escape hatch
 * @returns one summary per series with at least one valid sample
 */
export function summarizeSeries(raw: unknown, opts?: SummarizeOptions): readonly SeriesSummary[] {
  const result = extractResult(raw);
  if (!result) return [];

  return result.flatMap((entry): SeriesSummary[] => {
    if (entry === null || typeof entry !== "object") return [];
    const { metric, values, value } = entry as {
      metric?: unknown;
      values?: unknown;
      value?: unknown;
    };

    const labels = toLabels(metric);
    if (!labels) return [];

    // A `matrix` result (query_range) carries plural `values`; a `vector` result
    // (instant query) carries a singular `value: [ts, "n"]`. Reading only `values`
    // silently summarized every instant query to zero series.
    const points = toPoints(values ?? (value === undefined ? undefined : [value]));
    if (points.length === 0) return [];

    const extremes = reduceExtremes(points);
    const [firstTs, first] = points[0];
    const [lastTs, last] = points[points.length - 1];

    const base: SeriesSummary = {
      labels,
      ...extremes,
      first,
      last,
      firstTs,
      lastTs,
      delta: last - first,
      points: points.length,
    };

    if (!opts?.includePoints) return [base];

    return [
      {
        ...base,
        values: points.slice(0, MAX_INCLUDED_POINTS),
        pointsTruncated: points.length > MAX_INCLUDED_POINTS,
      },
    ];
  });
}

/** Base-1000 unit ladder. Deliberately KB/MB/GB, not KiB/MiB/GiB. */
const UNITS = ["KB", "MB", "GB", "TB", "PB"] as const;

/**
 * Format a byte count in base-1000 units — not a style choice: Kinetica's tier limits are
 * configured base-1000, so a base-1024 rendering overstates headroom ~7% per unit step.
 * Returns "n/a" for non-finite input rather than throwing.
 */
export function formatBytesBase1000(bytes: number): string {
  if (!Number.isFinite(bytes)) return "n/a";
  if (bytes === 0) return "0 B";
  if (Math.abs(bytes) < 1000) return `${bytes} B`;

  const scaled = UNITS.reduce<{ value: number; unit: string }>(
    (acc, unit) => (Math.abs(acc.value) >= 1000 ? { value: acc.value / 1000, unit } : acc),
    { value: bytes, unit: "B" },
  );

  return `${scaled.value.toFixed(2)} ${scaled.unit}`;
}
