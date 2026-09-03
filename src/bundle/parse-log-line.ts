/**
 * parse-log-line — tolerant parser for a single Kinetica log line.
 *
 * Kinetica logs come in (at least) two dialects, both starting with a
 * fixed-width timestamp + severity:
 *
 *   core ranks (gpudb-rolling-r0.log):
 *     2026-06-11 15:18:06.569 INFO  (55114,55114,r0/gpudb_cluster_i) node2 App/GaiaApp.cpp:431 - message
 *
 *   component logs (gpudb-sql-engine.log):
 *     2026-06-11 15:18:03.000 INFO (54820,1,sql) gpudb-sql-engine.sh Starting Kinetica SQL Engine
 *
 *   Loki/promtail JSONL exports (logs/rank0.log et al.):
 *     {"labels":{"level":"info"},"line":"… : INFO (…) host src.cpp:1 - msg","timestamp":"…"}
 *   These are unwrapped to a standard line first (see unwrap-loki-jsonl); the dialects
 *   below then apply to the unwrapped form.
 *
 * The common prefix is `timestamp severity (pid,tid,context)`; everything
 * after is best-effort. The core dialect adds `host source.cpp:line - message`;
 * the component dialect does not. Lines that do not match the prefix (stack
 * traces, continuation lines, sysinfo headers) are returned as a raw message —
 * never dropped.
 *
 * The timestamp is kept as its original fixed-width string. Because the format
 * is `YYYY-MM-DD HH:MM:SS.mmm`, lexical string comparison is chronological, so
 * callers can range-filter without timezone-fraught epoch conversion — but only within
 * one clock, which is what `timestampZone` reports. See TimestampZone.
 *
 * Pure, never throws.
 */

import { unwrapLokiJsonl, type LokiStampSource } from "./unwrap-loki-jsonl.js";

/**
 * Which clock wrote a parsed timestamp: `"local"` = Kinetica's own host-local stamp, no
 * zone marker (rolling logs, and a pass-through Loki record that kept it); `"utc"` = a
 * Loki export substituted its own.
 *
 * The bundle records no UTC offset, so across zones one event has two wall-clock times
 * and lexical order is meaningless — callers surface the zone instead of ordering across it.
 *
 * BUNDLE LOG LINES only. Do NOT widen for a live source: every label string built on this
 * is bundle-specific, and the live tools already declare their one fixed zone per note.
 */
const TIMESTAMP_ZONES = ["local", "utc"] as const;
export type TimestampZone = (typeof TIMESTAMP_ZONES)[number];

/**
 * One bit per zone, for accumulating which clocks a whole file held.
 *
 * A `Set` measured ~2 ms slower per 20 MB log — this runs on every MATCHED line, and a
 * two-value domain needs no hashing — and a mask lets callers early-out at ALL_ZONE_BITS.
 */
export const ZONE_BITS: Readonly<Record<TimestampZone, number>> = { local: 1, utc: 2 };

/** Both clocks seen — further lines can add nothing. */
export const ALL_ZONE_BITS = ZONE_BITS.local | ZONE_BITS.utc;

/** The zones present in `mask`, in stable TIMESTAMP_ZONES order. */
export function orderZones(mask: number): readonly TimestampZone[] {
  return TIMESTAMP_ZONES.filter((z) => (mask & ZONE_BITS[z]) !== 0);
}

/** Only `passthrough` keeps Kinetica's stamp; the other two are Loki's own. */
function zoneOfStampSource(source: LokiStampSource): TimestampZone {
  return source === "passthrough" ? "local" : "utc";
}

export interface ParsedLogLine {
  /** Raw timestamp string, e.g. "2026-06-11 15:18:06.569". Sorts chronologically as a string. */
  readonly timestamp?: string;
  /** Clock that wrote `timestamp` — present iff `timestamp` is. */
  readonly timestampZone?: TimestampZone;
  /** Raw severity token, e.g. "INFO", "WARN", "ERROR", "UERR", "FATAL". */
  readonly severity?: string;
  readonly pid?: string;
  readonly tid?: string;
  /** Third field of the `(pid,tid,context)` tuple — e.g. "r0/gpudb_cluster_i" or "sql". */
  readonly context?: string;
  /** Rank extracted from context when it looks like "r0", "r12", etc. */
  readonly rank?: string;
  /** Hostname (core dialect only), e.g. "node2". */
  readonly host?: string;
  /** Source location (core dialect only), e.g. "App/GaiaApp.cpp:431". */
  readonly source?: string;
  /** Human-readable message. Always present (falls back to the raw line). */
  readonly message: string;
  /** The original, unmodified line. */
  readonly raw: string;
}

// Common prefix: timestamp, severity (bare uppercase token — width varies), (pid,tid,context), rest.
const PREFIX_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+([A-Z]+)\s+\(([^)]*)\)\s*(.*)$/;

// Core-dialect tail: "host source.ext:line - message".
const CORE_TAIL_RE = /^(\S+)\s+(\S+:\d+)\s+-\s+(.*)$/;

// Rank token at the start of the context field.
const RANK_RE = /^(r\d+)\b/;

/** Severity ordering for `minSeverity` filtering. Higher = more severe. */
const SEVERITY_RANK: Readonly<Record<string, number>> = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  UERR: 4,
  ERROR: 5,
  FATAL: 6,
};

/**
 * Numeric rank for a severity token, for threshold comparisons.
 * Unknown or absent severities return -1 (never pass a `>=` severity filter).
 */
export function severityRank(severity?: string): number {
  if (severity === undefined) return -1;
  return SEVERITY_RANK[severity] ?? -1;
}

export function parseLogLine(line: string): ParsedLogLine {
  // Loki JSONL records (logs/rank*.log) are unwrapped to a standard line first; raw
  // (non-JSONL) lines pass through untouched. `raw` always preserves the ORIGINAL line
  // so regex search still tests the true bundle content.
  const unwrapped = unwrapLokiJsonl(line);
  const effective = unwrapped?.line ?? line;
  const match = PREFIX_RE.exec(effective);
  if (!match) {
    return { message: effective, raw: line };
  }

  const [, timestamp, severity, paren, rest] = match;
  // The unwrapper's call, not a guess from whether it fired.
  const timestampZone: TimestampZone =
    unwrapped !== undefined ? zoneOfStampSource(unwrapped.stampSource) : "local";
  const parts = paren.split(",");
  const pid = parts[0]?.trim() || undefined;
  const tid = parts[1]?.trim() || undefined;
  const context = parts.slice(2).join(",").trim() || undefined;
  const rank = context ? (RANK_RE.exec(context)?.[1] ?? undefined) : undefined;

  const coreTail = CORE_TAIL_RE.exec(rest);
  if (coreTail) {
    const [, host, source, message] = coreTail;
    return {
      timestamp,
      timestampZone,
      severity,
      pid,
      tid,
      context,
      rank,
      host,
      source,
      message,
      raw: line,
    };
  }

  return { timestamp, timestampZone, severity, pid, tid, context, rank, message: rest, raw: line };
}
