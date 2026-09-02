/**
 * lokiQuery — read the cluster's structured event streams from Loki.
 *
 * NOT a log-line viewer: with `enable_promtail` false (the default) Loki holds no rank
 * logs at all. It holds events the database emits directly, across five `class` values —
 * sql (per-statement telemetry), job (request failures), status (rank transitions),
 * config, mode. Bodies are JSON objects, not text, so renderEntry dispatches on shape;
 * `class="sql"` has no `log` key and would otherwise print raw JSON.
 *
 * Stack traces and full multi-line SQL live only in the rolling logs — use a bundle.
 *
 * Never throws.
 */

import { z } from "zod";
import type { ToolResult } from "../../types/index.js";
import type { ObservabilityClient } from "../../observability/ObservabilityClient.js";

const DEFAULT_MINUTES_BACK = 60;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
/** Matches every stream: `cluster` is present on every record the database emits. */
const MATCH_ALL_SELECTOR = '{cluster=~".+"}';
/** Longest rendered body before truncation, per entry. */
const MAX_MESSAGE_CHARS = 400;

export const LokiQuerySchema = z.object({
  selector: z
    .string()
    .optional()
    .describe('Raw LogQL selector, e.g. {class="sql"}. Overrides the class/severity conveniences.'),
  class: z.string().optional().describe("Event class: sql | job | status | config | mode."),
  severity: z.string().optional().describe("Severity label, e.g. info or uerr."),
  source: z.string().optional().describe('Emitter, e.g. "rank0" or "hostmanager0".'),
  contains: z.string().optional().describe("Substring the record body must contain."),
  minutes_back: z
    .number()
    .int()
    .positive()
    .max(10080)
    .optional()
    .describe("Lookback window in minutes (default 60, max 10080 = 7 days)."),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .optional()
    .describe(`Maximum entries to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
});

export type LokiQueryInput = z.infer<typeof LokiQuerySchema>;

/** One flattened event. */
export type LokiEntry = {
  readonly time: string;
  readonly class: string;
  readonly severity: string;
  readonly source: string;
  readonly what: string;
  readonly who: string;
  readonly message: string;
};

export type LokiQueryData = {
  readonly selector: string;
  readonly entry_count: number;
  readonly entries: readonly LokiEntry[];
};

/**
 * Lenient `{"log":"..."}` extractor for bodies that are not valid JSON.
 *
 * Measured on a live cluster: Kinetica does not escape double quotes inside the log
 * string, so an envelope like
 *   {"log":"... Syntax error near "some_table" at line 1 ..."}
 * fails JSON.parse. That hits precisely the messages worth reading, since SQL errors
 * quote the offending token. Anchored to the whole body so it cannot match mid-string.
 */
const LOG_ENVELOPE_RE = /^\s*\{\s*"log"\s*:\s*"([\s\S]*)"\s*\}\s*$/;

/** Keys echoed by their millisecond twins; printing both is pure noise. */
const SQL_REDUNDANT_KEYS = new Set(["start_time_ms", "end_time_ms", "start_time", "end_time"]);

/** Render a `class="sql"` telemetry record as one readable line. */
function renderSqlRecord(record: Record<string, unknown>): string {
  const { elapsed, jobid, resource_group, statement, user } = record as {
    elapsed?: number;
    jobid?: number;
    resource_group?: string;
    statement?: string;
    user?: string;
  };
  const head = [
    elapsed === undefined ? undefined : `${elapsed}s`,
    jobid === undefined ? undefined : `job=${jobid}`,
    user === undefined ? undefined : `user=${user}`,
    resource_group === undefined ? undefined : `rg=${resource_group}`,
  ]
    .filter(Boolean)
    .join(" ");
  return statement ? `${head} :: ${statement}` : head;
}

/** Render an unrecognized object as compact `key=value` pairs. */
function renderGeneric(record: Record<string, unknown>): string {
  return (
    Object.entries(record)
      .filter(([k]) => !SQL_REDUNDANT_KEYS.has(k))
      // v is unknown. A bare String() on an object yields "[object Object]", silently
      // discarding the very field worth reading in an unrecognized record; strings are
      // kept bare so the common case does not gain a layer of quotes.
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : (JSON.stringify(v) ?? "undefined")}`)
      .join(" ")
  );
}

/**
 * Render one Loki record body.
 *
 * Dispatches on shape rather than on the stream's `class` label, so a body that arrives
 * under an unexpected class still renders usefully instead of dumping JSON.
 */
export function renderEntry(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not valid JSON — most often an unescaped quote inside a {"log":"..."} envelope.
    return LOG_ENVELOPE_RE.exec(body)?.[1] ?? body;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return body;
  const record = parsed as Record<string, unknown>;

  if (typeof record.log === "string") return record.log;
  if (typeof record.statement === "string" || record.jobid !== undefined) {
    return renderSqlRecord(record);
  }
  return renderGeneric(record);
}

/**
 * Build the LogQL query from either a raw selector or the label conveniences.
 *
 * `contains` applies to BOTH forms. An earlier version returned a raw `selector`
 * before appending the line filter, so a call passing both ran an unfiltered query and
 * returned up to `limit` arbitrary records — from which the agent could reasonably
 * conclude the substring was everywhere. The tool description advertises them as
 * independent, and now they are.
 */
function buildSelector(input: LokiQueryInput): string {
  const base = input.selector ?? buildLabelSelector(input);
  // Backticks, not quotes: a LogQL line filter in backticks needs no escaping, and event
  // bodies routinely contain the double quotes of their own JSON.
  return input.contains ? `${base} |= \`${input.contains}\`` : base;
}

/** Selector assembled from the class/severity/source conveniences. */
function buildLabelSelector(input: LokiQueryInput): string {
  const matchers = [
    input.class ? `class="${input.class}"` : undefined,
    input.severity ? `severity="${input.severity}"` : undefined,
    input.source ? `source="${input.source}"` : undefined,
  ].filter(Boolean);

  return matchers.length > 0 ? `{${matchers.join(",")}}` : MATCH_ALL_SELECTOR;
}

/**
 * Collapse whitespace, escape pipes, truncate. Both matter for the markdown table:
 * `class="sql"` statements arrive multi-line, and `||` (SQL concatenation) would inject
 * extra cells. Formatting is sacrificed to keep the row parseable.
 */
function clamp(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return oneLine.length > MAX_MESSAGE_CHARS
    ? `${oneLine.slice(0, MAX_MESSAGE_CHARS)}… (truncated)`
    : oneLine;
}

/** Nanosecond epoch string to UTC HH:MM:SS. */
function nsToClock(ns: string): string {
  const ms = Number(BigInt(ns) / 1_000_000n);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 19) : "?";
}

/** Flatten Loki's per-stream shape into a single newest-first list. */
function flatten(result: readonly unknown[], limit: number): readonly LokiEntry[] {
  const rows = result.flatMap((entry): { ns: bigint; row: LokiEntry }[] => {
    if (entry === null || typeof entry !== "object") return [];
    const { stream, values } = entry as { stream?: unknown; values?: unknown };
    if (stream === null || typeof stream !== "object" || !Array.isArray(values)) return [];
    const labels = stream as Record<string, string>;

    return values.flatMap((v): { ns: bigint; row: LokiEntry }[] => {
      if (!Array.isArray(v) || v.length < 2) return [];
      const [ns, body] = v as [string, string];
      let sortKey: bigint;
      try {
        sortKey = BigInt(ns);
      } catch {
        return [];
      }
      return [
        {
          ns: sortKey,
          row: {
            time: nsToClock(ns),
            class: labels.class ?? "",
            severity: labels.severity ?? "",
            source: labels.source ?? "",
            what: labels.what ?? "",
            who: labels.who ?? "",
            message: clamp(renderEntry(body)),
          },
        },
      ];
    });
  });

  return rows
    .sort((a, b) => (b.ns > a.ns ? 1 : b.ns < a.ns ? -1 : 0))
    .slice(0, limit)
    .map((r) => r.row);
}

/**
 * Query Loki's structured event streams.
 *
 * @param client - configured observability client
 * @param input  - validated tool input
 */
export async function lokiQuery(
  client: ObservabilityClient,
  input: LokiQueryInput,
): Promise<ToolResult<LokiQueryData>> {
  const selector = buildSelector(input);
  const limit = input.limit ?? DEFAULT_LIMIT;
  const endMs = Date.now();
  const windowMs = (input.minutes_back ?? DEFAULT_MINUTES_BACK) * 60_000;
  // Nanosecond epochs exceed Number.MAX_SAFE_INTEGER, so they are built as BigInt and
  // kept as strings all the way to the query parameters.
  const endNs = (BigInt(endMs) * 1_000_000n).toString();
  const startNs = (BigInt(endMs - windowMs) * 1_000_000n).toString();

  try {
    const response = await client.lokiRange(selector, startNs, endNs, limit);
    const raw = await response.text();

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        status: response.status,
        error: `Loki returned a non-JSON body (HTTP ${response.status}).`,
        raw,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `Loki request failed with HTTP ${response.status}. Check the LogQL selector syntax.`,
        raw,
      };
    }

    // JSON.parse("null") succeeds, so `body` may be null — optional chaining does not
    // help until after the first dereference.
    const result =
      body !== null && typeof body === "object"
        ? (body as { data?: { result?: unknown } }).data?.result
        : undefined;
    const entries = Array.isArray(result) ? flatten(result, limit) : [];

    return {
      ok: true,
      data: { selector, entry_count: entries.length, entries },
      rowCount: entries.length,
      note:
        entries.length === 0
          ? `No entries for \`${selector}\` in the last ${input.minutes_back ?? DEFAULT_MINUTES_BACK} minutes. Loki retention is short (hours to days) and there is no backfill — widen minutes_back, or use a support bundle for older evidence.`
          : `Newest first, times UTC HH:MM:SS. Loki carries structured EVENTS, not rank log lines (enable_promtail defaults to false) — for stack traces or full multi-line SQL, use a support bundle.`,
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
