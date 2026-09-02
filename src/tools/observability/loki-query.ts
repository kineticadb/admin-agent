/**
 * lokiQuery — read the cluster's Loki streams: structured events always, and rank log
 * lines too when `enable_promtail` is on.
 *
 * Loki holds TWO populations, and they share only cluster/host/ring:
 *
 *   events (always) — pushed by the database itself, keyed by `class`: sql, job, status,
 *     config, mode. Bodies are JSON objects, so renderEntry dispatches on shape.
 *   log lines (only with `enable_promtail=true`) — shipped by promtail, keyed by `job`
 *     (gpudb_log, gpudb_sql_log, gpudb_graph_log, gpudb_tomcat_log, …) with `app`,
 *     `level` and `filename`. Bodies are plain-text core-dialect lines, so they are
 *     handed to the same parser the bundle tools use.
 *
 * The two populations name the same things differently — `source="rank0"` vs
 * `app="rank-0"`, `severity` vs `level` — so the conveniences translate per stream kind
 * rather than making the caller learn both vocabularies.
 *
 * Measured: ~60k log lines/hour against a few hundred events over DAYS. A cluster-wide
 * default would therefore spend the entire limit on log lines and silently bury the
 * events this tool was built to surface, so `stream` defaults to "events".
 *
 * Stack traces and full multi-line SQL still need a bundle — see the multi-line note.
 *
 * Never throws.
 */

import { z } from "zod";
import type { ToolResult } from "../../types/index.js";
import type { ObservabilityClient } from "../../observability/ObservabilityClient.js";
import { parseLogLine } from "../../bundle/parse-log-line.js";

const DEFAULT_MINUTES_BACK = 60;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
/**
 * Base selector per stream kind, used when no convenience filter narrows the query.
 *
 * `cluster` is on both populations; `job` is on promtail streams and no event stream.
 * Events are therefore defined by EXCLUDING promtail rather than by requiring `class`,
 * which matters for back-compat: on a cluster that never ran promtail nothing carries
 * `job`, so the events base collapses to `{cluster=~".+"}` — the pre-promtail default,
 * byte for byte, by construction rather than by measuring any particular cluster.
 * Requiring `class=~".+"` would instead silently drop any event stream lacking that
 * label, and would hide a future third population entirely.
 *
 * Verified on a live cluster over full retention: 58 event + 28 promtail = 86 total
 * streams, `{cluster=~".+",job=""}` returns exactly the 58, and no stream carries
 * neither label.
 */
const BASE_SELECTOR: Readonly<Record<StreamKind, string>> = {
  events: '{cluster=~".+",job=""}',
  logs: '{job=~".+"}',
  all: '{cluster=~".+"}',
};

/**
 * Services promtail labels without an ordinal. There is one host manager per host, so
 * the event vocabulary's `hostmanager0` is simply `hostmanager` in the `app` label.
 */
const APP_SINGLETONS: ReadonlySet<string> = new Set(["hostmanager"]);
/** Longest rendered body before truncation, per entry. */
const MAX_MESSAGE_CHARS = 400;

/** Which population of Loki streams to read. */
export type StreamKind = "events" | "logs" | "all";

export const LokiQuerySchema = z.object({
  stream: z
    .enum(["events", "logs", "all"])
    .optional()
    .describe(
      'Which streams to read: "events" (default) for the database\'s structured events, ' +
        '"logs" for promtail-shipped rank log lines, "all" for both. Defaults to "logs" ' +
        "when `job` is given.",
    ),
  selector: z
    .string()
    .optional()
    .describe('Raw LogQL selector, e.g. {class="sql"}. Overrides the class/severity conveniences.'),
  class: z.string().optional().describe("Event class: sql | job | status | config | mode."),
  severity: z
    .string()
    .optional()
    .describe(
      'Severity: info | uerr for events, info | warn | error | uerr for logs. Mapped to the "level" label when reading logs.',
    ),
  source: z
    .string()
    .optional()
    .describe(
      'Emitter, e.g. "rank0" or "hostmanager0". Translated to the hyphenated "app" label when reading logs.',
    ),
  job: z
    .string()
    .optional()
    .describe(
      "Log family (logs only): gpudb_log (ranks + host manager), gpudb_sql_log, gpudb_graph_log, gpudb_reveal_log, gpudb_tomcat_log, gpudb_tomcat_access_log, gpudb_workbench_log.",
    ),
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

/**
 * One flattened record, event or log line.
 *
 * `class` and `job` are mutually exclusive and together identify which population a row
 * came from — an event has a class, a log line has a job. `severity` and `source` are
 * shared columns fed from whichever label the stream uses.
 */
export type LokiEntry = {
  readonly time: string;
  readonly class: string;
  readonly job: string;
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
 * Render a promtail-shipped log line by reusing the bundle's parser.
 *
 * The raw line repeats in text what the row already carries as columns — timestamp,
 * severity, rank — plus a pid/tid tuple of no diagnostic value, roughly 90 characters of
 * boilerplate per row. Stripping it also buys back that much room inside the message
 * clamp, which is why MAX_MESSAGE_CHARS does not need raising for the logs path.
 *
 * A line with no parseable timestamp is a continuation line, a stack frame, or not a
 * Kinetica record at all — returned untouched rather than mangled.
 */
function renderLogLine(body: string): string {
  const parsed = parseLogLine(body);
  if (parsed.timestamp === undefined) return body;
  return parsed.source ? `${parsed.source} - ${parsed.message}` : parsed.message;
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
    // Not valid JSON — either an unescaped quote inside a {"log":"..."} envelope, or a
    // promtail-shipped plain-text log line.
    const envelope = LOG_ENVELOPE_RE.exec(body)?.[1];
    return envelope ?? renderLogLine(body);
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
function buildSelector(input: LokiQueryInput, kind: StreamKind): string {
  const base = input.selector ?? buildLabelSelector(input, kind);
  // Backticks, not quotes: a LogQL line filter in backticks needs no escaping, and event
  // bodies routinely contain the double quotes of their own JSON.
  return input.contains ? `${base} |= \`${input.contains}\`` : base;
}

/**
 * Which population to read. Supplying `job` implies logs: no event stream carries that
 * label, so honouring an events default there would guarantee an empty result.
 */
export function resolveStreamKind(input: LokiQueryInput): StreamKind {
  return input.stream ?? (input.job ? "logs" : "events");
}

/**
 * Event `source` to promtail `app`.
 *
 * Measured vocabularies: events say `rank0`/`hostmanager0`, promtail says
 * `rank-0`/`hostmanager`/`graph-0`. An already-hyphenated name is passed through so a
 * caller who knows the app label can use it directly.
 */
export function toAppLabel(source: string): string {
  if (source.includes("-")) return source;
  const match = /^([A-Za-z_]+?)(\d+)$/.exec(source);
  if (!match) return source;
  const [, base, ordinal] = match;
  return APP_SINGLETONS.has(base.toLowerCase()) ? base : `${base}-${ordinal}`;
}

/** Selector assembled from the conveniences, in the vocabulary of the chosen streams. */
function buildLabelSelector(input: LokiQueryInput, kind: StreamKind): string {
  const matchers =
    kind === "logs"
      ? [
          input.job ? `job="${input.job}"` : undefined,
          // level values are lowercase; an agent reading log TEXT sees "ERROR".
          input.severity ? `level="${input.severity.toLowerCase()}"` : undefined,
          input.source ? `app="${toAppLabel(input.source)}"` : undefined,
        ]
      : [
          input.class ? `class="${input.class}"` : undefined,
          input.severity ? `severity="${input.severity}"` : undefined,
          input.source ? `source="${input.source}"` : undefined,
          input.job ? `job="${input.job}"` : undefined,
        ];

  const present = matchers.filter(Boolean);
  return present.length > 0 ? `{${present.join(",")}}` : BASE_SELECTOR[kind];
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
            job: labels.job ?? "",
            // Events and log lines label the same concepts differently; the columns are
            // shared so a stream="all" result stays one readable table.
            severity: labels.severity ?? labels.level ?? "",
            source: labels.source ?? labels.app ?? "",
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
 * Guidance for an empty result, specific to what was being read.
 *
 * A logs query returning nothing is usually not a retention problem but a configuration
 * one, and the fix has a step operators miss: `enable_promtail` is written to
 * `gpudb.conf`, but the running process never re-reads that file, so nothing ships until
 * the stats stack is restarted. Measured — the setting sat enabled with zero log lines in
 * Loki until `kinetica_stats` was restarted, at which point ingest went from 282 lifetime
 * lines to ~60k/hour.
 */
function emptyNote(selector: string, minutesBack: number, kind: StreamKind): string {
  const base = `No entries for \`${selector}\` in the last ${minutesBack} minutes.`;
  if (kind === "events") {
    return `${base} Events are pushed live with no backfill, and Loki retention is short (hours to days) — widen minutes_back, or use a support bundle for older evidence.`;
  }
  if (kind === "all") {
    // "all" spans both populations, so emptiness implicates the selector or the window,
    // never promtail — saying otherwise sends the agent after a config problem that
    // cannot be the cause here.
    return `${base} This matched neither events nor log lines, so the selector or the window is the likely problem rather than any missing capability — widen minutes_back, or relax the filters (a \`contains\` substring is the usual culprit).`;
  }
  return `${base} Either nothing matched in this window, or this cluster ships no rank log lines at all: promtail is off by default. \`enable_promtail\` must be true in gpudb.conf AND the stats stack restarted afterwards (the running process does not re-read the file) before anything appears here. Check with stream="events", which works regardless — if events are present and logs are not, promtail is the missing piece.`;
}

/** Caveats for a non-empty result, specific to what was read. */
function resultNote(kind: StreamKind): string {
  const head = "Newest first, times UTC HH:MM:SS.";
  if (kind === "events") {
    return `${head} These are structured EVENTS, not log lines. If the cluster has promtail enabled, stream="logs" reaches the actual rank logs; for stack traces or full multi-line SQL, use a support bundle.`;
  }
  return `${head} Log lines carry \`job\` and \`source\` (the rank); events carry \`class\`. Promtail is LINE-oriented, so a multi-line record — notably \`Executing SQL:\` — is split, and its continuation lines land in a SEPARATE stream with no \`app\` label and ingest-time timestamps, so they do NOT reliably pair with their parent. Report the first line as the first line, never as the whole statement; the complete text is only in a support bundle's rolling logs.`;
}

/**
 * Query Loki's event and/or log streams.
 *
 * @param client - configured observability client
 * @param input  - validated tool input
 */
export async function lokiQuery(
  client: ObservabilityClient,
  input: LokiQueryInput,
): Promise<ToolResult<LokiQueryData>> {
  const kind = resolveStreamKind(input);
  const selector = buildSelector(input, kind);
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
          ? emptyNote(selector, input.minutes_back ?? DEFAULT_MINUTES_BACK, kind)
          : resultNote(kind),
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
