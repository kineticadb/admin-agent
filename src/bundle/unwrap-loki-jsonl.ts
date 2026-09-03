/**
 * unwrap-loki-jsonl — turn a Loki/promtail JSONL log record into the plain
 * Kinetica log line the rest of the parser understands.
 *
 * A Loki-based collector exports per-rank and per-component logs under logs/ as
 * JSONL — one JSON object per line, NOT the raw Kinetica log format:
 *
 *   {"labels":{"level":"info"},"line":"2026-06-17 18:25:57.319 info gpudb_log rank-0 :  INFO  (906186,907730,r0/gpudb_gblreg   ) host Utils/X.cpp:1406 - msg","timestamp":"2026-06-17T18:25:57.319Z"}
 *
 * The `line` field is `<loki-ts> <level> <job> <app> : <body>`, where <body> is the
 * ORIGINAL Kinetica log line — its leading timestamp stripped by the logcli
 * line_format, but its uppercase severity (INFO/WARN/UERR/ERROR/FATAL) intact. We
 * reconstruct a standard `<ts> <body>` line so the existing parseLogLine prefix/tail
 * regexes apply unchanged (and severity/timestamp filtering works).
 *
 * The <ts> we emit is the record's RFC 3339 `timestamp` field (UTC by format), normalized
 * to millisecond width; the rendered <loki-ts> is a fallback.
 *
 * Without this, parseLogLine sees a line starting with `{`, fails its prefix regex,
 * and returns the whole JSON blob as a raw message with NO severity/timestamp — so a
 * minSeverity-filtered search or a timeline over a rank log silently matches nothing.
 *
 * Returns the line plus its stamp's provenance, or undefined for non-JSONL input (the
 * caller then parses it as a raw line). Provenance is RETURNED, not inferred from "did
 * this fire": the pass-through branch emits Kinetica's original host-local stamp, so
 * "unwrapped implies UTC" would label it UTC and hide a mixed-clock result.
 * Pure, never throws.
 */

/** Which clock wrote the stamp on the returned line. */
export type LokiStampSource =
  /** The record's RFC 3339 `timestamp` field. */
  | "utc-field"
  /** Loki's rendered stamp — its clock too, used when the `timestamp` field won't parse. */
  | "rendered"
  /** No Loki header found, so `line` is the inner text verbatim: any stamp is Kinetica's. */
  | "passthrough";

export interface UnwrappedLokiLine {
  readonly line: string;
  readonly stampSource: LokiStampSource;
}

// Leading "<date> <time>" timestamp at the start of the `.line` field — the Loki
// __timestamp__ rendered in space-separated form (sorts lexically as chronological).
const LEADING_TS_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+/;

// The logcli line_format separator between the Loki header tokens and the original
// log body: "<ts> <level> <job> <app> : <body>". The header tokens never contain a
// " : " (space-colon-space), so the FIRST occurrence is always the real separator.
const HEADER_BODY_SEP = " : ";

// The record's `timestamp` field: RFC 3339 UTC, any fraction length (Loki sends
// nanoseconds; a whole second has none).
const RFC3339_UTC_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

/** "2026-06-17T18:25:57.319123Z" → "2026-06-17 18:25:57.319" (core-dialect width). */
function utcFieldToLogStamp(field: unknown): string | undefined {
  if (typeof field !== "string") return undefined;
  const m = RFC3339_UTC_RE.exec(field);
  if (!m) return undefined;
  const [, date, time, fraction = ""] = m;
  return `${date} ${time}.${fraction.padEnd(3, "0").slice(0, 3)}`;
}

export function unwrapLokiJsonl(line: string): UnwrappedLokiLine | undefined {
  // Fast reject without allocating: scan to the first non-whitespace char and bail
  // unless it's '{'. parseLogLine calls this for EVERY line of a multi-MB rank log, so
  // the raw-line path (the vast majority) must not pay a full-string trimStart() copy.
  let i = 0;
  while (i < line.length && line.charCodeAt(i) <= 0x20) i++;
  if (line.charCodeAt(i) !== 0x7b /* { */) return undefined; // NaN at end-of-string fails too

  let obj: unknown;
  try {
    obj = JSON.parse(line); // tolerant of the leading whitespace we skipped above
  } catch {
    return undefined; // not valid JSON → treat as a raw line
  }
  if (typeof obj !== "object" || obj === null) return undefined;
  const { line: inner, timestamp } = obj as { line?: unknown; timestamp?: unknown };
  if (typeof inner !== "string") return undefined;

  // inner = "<loki-ts> <level> <job> <app> : <body>". Rejoin the loki timestamp with
  // the body (which still carries the original uppercase severity) so the result is a
  // standard Kinetica log line.
  const tsMatch = LEADING_TS_RE.exec(inner);
  const sepIdx = inner.indexOf(HEADER_BODY_SEP);
  if (tsMatch && sepIdx !== -1) {
    // Prefer the UTC `timestamp` field (UTC by format); fall back to the rendered stamp.
    const utcField = utcFieldToLogStamp(timestamp);
    const body = inner.slice(sepIdx + HEADER_BODY_SEP.length).trim();
    return {
      line: `${utcField ?? tsMatch[1]} ${body}`,
      stampSource: utcField !== undefined ? "utc-field" : "rendered",
    };
  }

  // No recognizable Loki header (e.g. a continuation/stack line Loki captured whole) —
  // hand back the inner line for best-effort parsing rather than the JSON wrapper.
  return { line: inner, stampSource: "passthrough" };
}
