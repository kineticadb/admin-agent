/**
 * healthCheck — queries Kinetica system health status.
 *
 * Endpoint: POST /show/system/status
 * Returns: status_map with per-node status strings (e.g. "running", "stopped")
 *
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { flatObjectToRows } from "../../output/reshape.js";
import { parseDataStr } from "./parse-data-str.js";

export async function healthCheck(session: KineticaSession): Promise<ToolResult<unknown>> {
  let response: Response;
  let rawText: string;

  try {
    response = await session.makeRequest("/show/system/status", {});
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

  let parsed: { data_str?: string };
  try {
    parsed = JSON.parse(rawText) as typeof parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 200,
      error: `JSON parse error: ${message}`,
      raw: rawText,
    };
  }

  const inner = parseDataStr<{ status_map?: unknown }>(parsed.data_str, rawText);
  if (!inner.ok) return inner;

  const statusMap = (inner.data?.status_map ?? {}) as Record<string, unknown>;

  return {
    ok: true,
    data: flatObjectToRows(statusMap, "component", "status"),
  };
}
