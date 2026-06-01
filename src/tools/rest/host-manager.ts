/**
 * hostManagerStatus — queries the Kinetica host manager root endpoint.
 *
 * Endpoint: GET / on host manager port (default 9300, discovered via conf.hm_http_port)
 * Returns: flat JSON object with cluster-wide status (no data_str encoding, no auth required)
 *
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { flatObjectToRows } from "../../output/reshape.js";
import { parseDataStr } from "./parse-data-str.js";
import { discoverHmPort } from "./discover-hm-port.js";

/**
 * Flat key-value data returned by the host manager root endpoint.
 * The exact set of keys varies by Kinetica version, so we use a flexible type.
 */
export type HostManagerData = ReadonlyArray<{
  readonly key: string;
  readonly value: string | number;
}>;

export async function hostManagerStatus(
  session: KineticaSession,
): Promise<ToolResult<HostManagerData>> {
  // Check makeRequestToPort is available on this session
  if (!session.makeRequestToPort) {
    return {
      ok: false,
      status: 0,
      error: "makeRequestToPort not available on this session",
      raw: "",
    };
  }

  // Discover host manager port (falls back to 9300 on error)
  const hmPort = await discoverHmPort(session);

  let response: Response;
  let rawText: string;

  try {
    response = await session.makeRequestToPort(hmPort, "/", undefined);
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

  let parsed: Record<string, string | number>;
  try {
    parsed = JSON.parse(rawText) as Record<string, string | number>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 200,
      error: `JSON parse error: ${message}`,
      raw: rawText,
    };
  }

  return {
    ok: true,
    data: flatObjectToRows(parsed, "key", "value") as unknown as HostManagerData,
  };
}

// ---------------------------------------------------------------------------
// Host manager alerts — /admin/show/alerts on HM port
// ---------------------------------------------------------------------------

export type AlertEntry = {
  readonly timestamp: string;
  readonly type: string;
  readonly params: string;
};

/**
 * Fetches recent alerts from the host manager's /admin/show/alerts endpoint.
 * Returns up to 50 alerts as an array of { timestamp, type, params } entries.
 *
 * The response uses Kinetica's standard data_str double-encoding with
 * parallel arrays (timestamps[], types[], params[]) that are zipped into objects.
 *
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
export async function hostManagerAlerts(
  session: KineticaSession,
): Promise<ToolResult<ReadonlyArray<AlertEntry>>> {
  if (!session.makeRequestToPort) {
    return {
      ok: false,
      status: 0,
      error: "makeRequestToPort not available on this session",
      raw: "",
    };
  }

  const hmPort = await discoverHmPort(session);

  let response: Response;
  let rawText: string;

  try {
    response = await session.makeRequestToPort(hmPort, "/admin/show/alerts", {
      num_alerts: 50,
      options: {},
    });
    rawText = await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: message, raw: "" };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}`,
      raw: rawText,
    };
  }

  let outer: Record<string, unknown>;
  try {
    outer = JSON.parse(rawText) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 200,
      error: `JSON parse error: ${message}`,
      raw: rawText,
    };
  }

  type AlertsData = {
    timestamps?: string[];
    types?: string[];
    params?: string[];
  };
  const inner = parseDataStr<AlertsData>(outer.data_str, rawText);
  if (!inner.ok) return inner;

  const timestamps = inner.data?.timestamps ?? [];
  const alertTypes = inner.data?.types ?? [];
  const alertParams = inner.data?.params ?? [];

  const alerts: ReadonlyArray<AlertEntry> = timestamps.map((ts, i) => ({
    timestamp: ts,
    type: alertTypes[i] ?? "",
    params: alertParams[i] ?? "",
  }));

  return { ok: true, data: alerts };
}
