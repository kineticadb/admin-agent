/**
 * systemTiming — queries Kinetica endpoint response timing statistics.
 *
 * Endpoint: POST /show/system/timing
 * Returns: per-endpoint average response times and job IDs zipped from
 * parallel arrays (endpoints[], time_in_ms[], jobIds[]).
 *
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { parseDataStr } from "./parse-data-str.js";

type TimingEntry = {
  readonly endpoint: string;
  readonly time_in_ms: number;
  readonly job_id: string;
};

type SystemTimingOuter = {
  data_str?: string;
};

type SystemTimingInner = {
  endpoints?: string[];
  time_in_ms?: number[];
  jobIds?: string[];
};

export async function systemTiming(session: KineticaSession): Promise<ToolResult<unknown>> {
  let response: Response;
  let rawText: string;

  try {
    response = await session.makeRequest("/show/system/timing", { options: {} });
    rawText = await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      error: message,
      raw: "",
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}`,
      raw: rawText,
    };
  }

  let parsed: SystemTimingOuter;
  try {
    parsed = JSON.parse(rawText) as SystemTimingOuter;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 200,
      error: `JSON parse error: ${message}`,
      raw: rawText,
    };
  }

  const inner = parseDataStr<SystemTimingInner>(parsed.data_str, rawText);
  if (!inner.ok) return inner;

  const endpoints = inner.data?.endpoints ?? [];
  const timings = inner.data?.time_in_ms ?? [];
  const jobIds = inner.data?.jobIds ?? [];

  const data: ReadonlyArray<TimingEntry> = endpoints.map((endpoint, i) => ({
    endpoint,
    time_in_ms: timings[i] ?? 0,
    job_id: jobIds[i] ?? "",
  }));

  return {
    ok: true,
    data,
  };
}
