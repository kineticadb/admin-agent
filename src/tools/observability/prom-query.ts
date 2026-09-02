/**
 * promQuery — raw PromQL, reduced to per-series stats.
 *
 * Two measured behaviours drive the error handling: a bad query returns HTTP 400 carrying
 * a precise parse error (surfaced verbatim so the agent can fix its PromQL), and a
 * NONEXISTENT metric returns HTTP 200 with an empty result — indistinguishable from "no
 * data in this window", so the note says so rather than reporting absence.
 *
 * Never throws.
 */

import { z } from "zod";
import type { ToolResult } from "../../types/index.js";
import type { ObservabilityClient } from "../../observability/ObservabilityClient.js";
import { summarizeSeries } from "../rest/summarize-timeseries.js";
import { toSeriesRows, describeWindow, type SeriesRow } from "./series-rows.js";

/**
 * Upper bound on STEPS (intervals) per series, whatever the window. The sample count is
 * one higher, since both endpoints are included — 200 steps yields 201 points.
 */
const MAX_STEPS = 200;
/** Prometheus' own scrape interval on a kagent install; a finer step buys nothing. */
const MIN_STEP_SECONDS = 10;
/** Default lookback when the caller does not say. */
const DEFAULT_MINUTES_BACK = 60;

export const PromQuerySchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      'PromQL expression, e.g. ki_db_tier{tier="ram",what="used_bytes"} or ki_host_mem{what="used"}.',
    ),
  minutes_back: z
    .number()
    .int()
    .positive()
    .max(10080)
    .optional()
    .describe("Lookback window in minutes (default 60, max 10080 = 7 days)."),
  step_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Sample interval. Omit to derive one that keeps the result compact."),
  instant: z
    .boolean()
    .optional()
    .describe("Query the current value only, instead of a range. Default false."),
  format: z
    .enum(["auto", "bytes", "raw"])
    .optional()
    .describe("Value rendering. 'auto' formats *_bytes series base-1000."),
});

export type PromQueryInput = z.infer<typeof PromQuerySchema>;

export type PromQueryData = {
  readonly query: string;
  readonly series_count: number;
  readonly series: readonly SeriesRow[];
};

/**
 * Choose a step that keeps any window under MAX_STEPS samples per series.
 *
 * A 7-day window at the 10s scrape interval would be 60,480 points per series; even
 * summarized, fetching that is pointless work. Bounding the step bounds the fetch.
 */
function deriveStep(windowSeconds: number): number {
  return Math.max(MIN_STEP_SECONDS, Math.ceil(windowSeconds / MAX_STEPS));
}

/** Extract Prometheus' `error` field from a response body, if present. */
function promError(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const { error, errorType } = body as { error?: unknown; errorType?: unknown };
  if (typeof error !== "string") return undefined;
  return typeof errorType === "string" ? `${errorType}: ${error}` : error;
}

/** Note explaining that an empty result is ambiguous. */
function emptyNote(query: string): string {
  return (
    `No series matched \`${query}\`. Prometheus returns 0 series both when a metric has no ` +
    `data in the window AND when the metric NAME does not exist — these look identical. ` +
    `Verify the name before concluding the data is absent.`
  );
}

/**
 * Run a PromQL query and summarize the result.
 *
 * @param client - configured observability client
 * @param input  - validated tool input
 */
export async function promQuery(
  client: ObservabilityClient,
  input: PromQueryInput,
): Promise<ToolResult<PromQueryData>> {
  const { query } = input;

  // The Prometheus HTTP API is read-only, so this is not a security boundary — it is a
  // clarity one. A caller passing an admin path has misunderstood the tool, and an
  // URL-encoded "/-/reload" would come back as an opaque parse error.
  if (query.trimStart().startsWith("/")) {
    return {
      ok: false,
      status: 0,
      error: `\`query\` must be a PromQL expression, not an HTTP path (got "${query}"). This tool only reads metrics.`,
      raw: "",
    };
  }

  const end = Math.floor(Date.now() / 1000);
  const windowSeconds = (input.minutes_back ?? DEFAULT_MINUTES_BACK) * 60;
  const start = end - windowSeconds;
  const step = input.step_seconds ?? deriveStep(windowSeconds);

  try {
    const response = input.instant
      ? await client.promInstant(query)
      : await client.promRange(query, start, end, step);

    const raw = await response.text();

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        status: response.status,
        error: `Prometheus returned a non-JSON body (HTTP ${response.status}).`,
        raw,
      };
    }

    const detail = promError(body);
    if (!response.ok || detail !== undefined) {
      return {
        ok: false,
        status: response.status,
        error: detail ?? `Prometheus request failed with HTTP ${response.status}.`,
        raw,
      };
    }

    const { rows, common } = toSeriesRows(summarizeSeries(body), {
      format: input.format,
    });

    // Shared labels go in the note, not on every row — see series-rows.ts.
    const commonNote = common ? `All series: ${common}.` : "";
    const windowNote = input.instant
      ? "Instant query — current value per series."
      : describeWindow(start, end, step);

    return {
      ok: true,
      data: { query, series_count: rows.length, series: rows },
      rowCount: rows.length,
      note:
        rows.length === 0 ? emptyNote(query) : [windowNote, commonNote].filter(Boolean).join(" "),
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
