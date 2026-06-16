/**
 * log-search — streaming search and timeline aggregation over a log file.
 *
 * Bundle logs are large (a single rolling rank log is ~20 MB / 100k lines), so
 * these functions NEVER read a file whole. They stream line-by-line via
 * node:readline and emit bounded results: `searchLogFile` caps the number of
 * returned matches (the total count is still reported), and `aggregateTimeline`
 * collapses millions of lines into a handful of per-time-bucket severity counts.
 *
 * Timestamps are compared lexically — the `YYYY-MM-DD HH:MM:SS.mmm` format sorts
 * chronologically as a string, so range filters and time buckets need no epoch
 * conversion (and dodge the timezone ambiguity of these tz-less stamps).
 *
 * Errors (missing file, read failure) are returned as a result with an `error`
 * field rather than thrown — callers degrade gracefully.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseLogLine, severityRank } from "./parse-log-line.js";

export const DEFAULT_MAX_MATCHES = 200;

/**
 * Upper bound on the characters of a single line that a user/agent-supplied
 * regex is tested against. Defense-in-depth against catastrophic backtracking
 * (ReDoS): the search pattern comes from tool input, and `regex.test()` runs on
 * every line of a ~100k-line file with no execution timeout (Node's RegExp can't
 * be interrupted). Capping the tested length removes the unbounded-input
 * dimension so a pathological pattern meeting a very long line can't stall the
 * scan. Real log lines are well under this; a match beyond it is forgone. NOTE:
 * this does NOT make exponential patterns safe on short input — for full ReDoS
 * immunity, swap RegExp for a linear-time engine (RE2) behind compileRegex().
 */
export const REGEX_SCAN_MAX = 8192;

/** Time-bucket granularity, expressed as the timestamp-prefix length that sorts chronologically. */
export type TimeGranularity = "day" | "hour" | "minute";

const GRANULARITY_LEN: Readonly<Record<TimeGranularity, number>> = {
  day: 10, // "2026-06-11"
  hour: 13, // "2026-06-11 15"
  minute: 16, // "2026-06-11 15:18"
};

export interface LogQuery {
  /** Regex tested against the raw line. */
  readonly regex?: string;
  /** Case-sensitive regex match (default false). */
  readonly caseSensitive?: boolean;
  /** Keep only lines whose severity is at least this (e.g. "WARN"). */
  readonly minSeverity?: string;
  /** Inclusive lower bound on the timestamp string (e.g. "2026-06-11 15:00:00.000"). */
  readonly fromTs?: string;
  /** Inclusive upper bound on the timestamp string. */
  readonly toTs?: string;
  /** Keep only lines whose parsed rank equals this (e.g. "r0"). */
  readonly rank?: string;
  /** Cap on returned matches (default DEFAULT_MAX_MATCHES). The total is still counted. */
  readonly maxMatches?: number;
}

export interface LogMatch {
  readonly lineNumber: number;
  readonly timestamp?: string;
  readonly severity?: string;
  readonly rank?: string;
  readonly message: string;
  readonly raw: string;
}

export interface LogSearchResult {
  readonly matches: readonly LogMatch[];
  /** Total lines that matched the query, even if more than `matches.length` were found. */
  readonly totalMatched: number;
  readonly linesScanned: number;
  /** True when matches were dropped to respect `maxMatches`. */
  readonly capped: boolean;
  readonly error?: string;
}

function compileRegex(query: LogQuery): RegExp | undefined {
  if (query.regex === undefined) return undefined;
  return new RegExp(query.regex, query.caseSensitive ? undefined : "i");
}

// Full-precision templates for widening a partial timestamp bound. Log timestamps
// are `YYYY-MM-DD HH:MM:SS.mmm`, which sorts lexically as chronological, so a
// partial bound (e.g. the timeline tool's hour bucket label "2026-06-11 15") must
// be padded to a full-width boundary before a lexical range comparison: a lower
// bound floors to the start of the period (.000), an upper bound ceils to its end
// (.999). Without this, `toTs="2026-06-11 15"` would lexically exclude every line
// in that very hour ("2026-06-11 15:18:..." > "2026-06-11 15"). The separators in
// the templates line up with bucket-label boundaries (lengths 10/13/16), so the
// slice-append preserves a valid timestamp string.
const TS_FLOOR = "0000-01-01 00:00:00.000";
const TS_CEIL = "9999-12-31 23:59:59.999";

// Prefix lengths at which a partial timestamp ends exactly on a field boundary, so
// slice-appending the template yields a valid timestamp: year(4), year-month(7),
// date(10), +hour(13), +minute(16), +second(19). A bound of any OTHER length (e.g.
// 12 = "YYYY-MM-DD H") lands mid-field — appending the template there corrupts it
// ("...11 1" → "...11 10:..."). We round DOWN to the nearest boundary so the window
// only ever WIDENS to the coarser period; an over-wide inclusive bound is harmless,
// a silently-shifted one wrongly excludes evidence.
const SAFE_PREFIX_LENS = [4, 7, 10, 13, 16, 19] as const;

/** Largest field-boundary prefix length not exceeding `len` (0 if shorter than a year). */
function alignPrefixLen(len: number): number {
  let aligned = 0;
  for (const n of SAFE_PREFIX_LENS) if (n <= len) aligned = n;
  return aligned;
}

/** Widen a partial lower-bound timestamp to the start of its period. */
export function floorTimestamp(ts: string): string {
  if (ts.length >= TS_FLOOR.length) return ts;
  const len = alignPrefixLen(ts.length);
  return ts.slice(0, len) + TS_FLOOR.slice(len);
}

/** Widen a partial upper-bound timestamp to the end of its period (inclusive). */
export function ceilTimestamp(ts: string): string {
  if (ts.length >= TS_CEIL.length) return ts;
  const len = alignPrefixLen(ts.length);
  return ts.slice(0, len) + TS_CEIL.slice(len);
}

function matchesFilters(
  parsed: ReturnType<typeof parseLogLine>,
  query: LogQuery,
  regex: RegExp | undefined,
  minRank: number,
): boolean {
  if (regex && !regex.test(parsed.raw.slice(0, REGEX_SCAN_MAX))) return false;
  if (query.minSeverity !== undefined && severityRank(parsed.severity) < minRank) return false;
  if (query.rank !== undefined && parsed.rank !== query.rank) return false;
  if (
    query.fromTs !== undefined &&
    (parsed.timestamp === undefined || parsed.timestamp < query.fromTs)
  )
    return false;
  if (query.toTs !== undefined && (parsed.timestamp === undefined || parsed.timestamp > query.toTs))
    return false;
  return true;
}

/**
 * Stream a log file, returning up to `maxMatches` matching lines plus the total
 * match count and lines scanned. Never reads the file whole; never throws.
 */
export async function searchLogFile(filePath: string, query: LogQuery): Promise<LogSearchResult> {
  const maxMatches = query.maxMatches ?? DEFAULT_MAX_MATCHES;
  const minRank = query.minSeverity !== undefined ? severityRank(query.minSeverity) : -Infinity;

  let regex: RegExp | undefined;
  try {
    regex = compileRegex(query);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      matches: [],
      totalMatched: 0,
      linesScanned: 0,
      capped: false,
      error: `invalid regex: ${message}`,
    };
  }

  // Normalize partial timestamp bounds once (e.g. a timeline bucket label) so the
  // per-line lexical comparison treats them as the start/end of their period.
  const boundedQuery: LogQuery = {
    ...query,
    ...(query.fromTs !== undefined ? { fromTs: floorTimestamp(query.fromTs) } : {}),
    ...(query.toTs !== undefined ? { toTs: ceilTimestamp(query.toTs) } : {}),
  };

  const matches: LogMatch[] = [];
  let totalMatched = 0;
  let linesScanned = 0;

  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      linesScanned++;
      const parsed = parseLogLine(line);
      if (!matchesFilters(parsed, boundedQuery, regex, minRank)) continue;

      totalMatched++;
      if (matches.length < maxMatches) {
        matches.push({
          lineNumber: linesScanned,
          ...(parsed.timestamp !== undefined ? { timestamp: parsed.timestamp } : {}),
          ...(parsed.severity !== undefined ? { severity: parsed.severity } : {}),
          ...(parsed.rank !== undefined ? { rank: parsed.rank } : {}),
          message: parsed.message,
          raw: parsed.raw,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      matches,
      totalMatched,
      linesScanned,
      capped: totalMatched > matches.length,
      error: message,
    };
  }

  return { matches, totalMatched, linesScanned, capped: totalMatched > matches.length };
}

export interface TimelineQuery {
  /** Count only lines at or above this severity (default "WARN"). */
  readonly minSeverity?: string;
  /** Bucket granularity (default "hour"). */
  readonly granularity?: TimeGranularity;
  /** Restrict to a single rank. */
  readonly rank?: string;
}

export interface TimelineBucket {
  /** Bucket label, e.g. "2026-06-11 15" for hourly granularity. */
  readonly bucket: string;
  /** Per-severity counts within the bucket. */
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
}

export interface TimelineResult {
  readonly buckets: readonly TimelineBucket[];
  readonly linesScanned: number;
  readonly totalCounted: number;
  readonly error?: string;
}

/**
 * Stream a log file and bucket matching lines by time, counting per severity.
 * Collapses a huge log into an at-a-glance incident shape. Never throws.
 */
export async function aggregateTimeline(
  filePath: string,
  query: TimelineQuery = {},
): Promise<TimelineResult> {
  const granularity = query.granularity ?? "hour";
  const prefixLen = GRANULARITY_LEN[granularity];
  const minRank = severityRank(query.minSeverity ?? "WARN");

  // Insertion order follows first-seen buckets, which is chronological for a forward scan.
  const buckets = new Map<string, Record<string, number>>();
  let linesScanned = 0;
  let totalCounted = 0;

  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      linesScanned++;
      const parsed = parseLogLine(line);
      if (parsed.timestamp === undefined || parsed.severity === undefined) continue;
      if (severityRank(parsed.severity) < minRank) continue;
      if (query.rank !== undefined && parsed.rank !== query.rank) continue;

      const key = parsed.timestamp.slice(0, prefixLen);
      const bucket = buckets.get(key) ?? {};
      bucket[parsed.severity] = (bucket[parsed.severity] ?? 0) + 1;
      buckets.set(key, bucket);
      totalCounted++;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { buckets: [], linesScanned, totalCounted, error: message };
  }

  const result: TimelineBucket[] = [];
  for (const [bucket, counts] of buckets) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    result.push({ bucket, counts, total });
  }

  return { buckets: result, linesScanned, totalCounted };
}
