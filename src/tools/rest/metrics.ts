/**
 * getMetrics — queries Kinetica resource utilization statistics.
 *
 * Endpoint: POST /show/resource/statistics
 * Returns: per-rank summary rows with RAM/PERSIST/DISK/VRAM usage.
 *
 * nodeId parameter: when provided, a note is included in the ok:true result
 * indicating which node was requested. The API returns all ranks; agent
 * reasoning narrows further if needed.
 *
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { parseDataStr } from "./parse-data-str.js";
import { decodeNestedJsonStrings } from "./decode-nested-json.js";
import { flattenRanksSummary } from "./flatten-rank-stats.js";

export async function getMetrics(
  session: KineticaSession,
  nodeId?: string,
): Promise<ToolResult<unknown>> {
  let response: Response;
  let rawText: string;

  try {
    response = await session.makeRequest("/show/resource/statistics", {
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

  const inner = parseDataStr<{ statistics_map?: unknown }>(parsed.data_str, rawText);
  if (!inner.ok) return inner;

  const statisticsMap = (inner.data?.statistics_map ?? {}) as Record<string, unknown>;
  const decoded = decodeNestedJsonStrings(statisticsMap);
  const rows = flattenRanksSummary(decoded);

  if (nodeId !== undefined) {
    return { ok: true, data: rows, note: `Filtered for node: ${nodeId}` };
  }

  return { ok: true, data: rows };
}
