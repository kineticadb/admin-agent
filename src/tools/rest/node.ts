/**
 * nodeDetails — queries per-node resource statistics from Kinetica.
 *
 * Endpoint: POST /show/resource/statistics
 * Returns: per-rank summary rows or detailed breakdown for a single rank.
 *
 * nodeId behavior:
 *   - Not provided: returns summary rows for all ranks
 *   - Provided and found in decoded.ranks: returns detailed tier + resource-group
 *     breakdown for that rank
 *   - Provided but not found: returns summary rows with a note explaining
 *     that the requested node_id was not found
 *
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { parseDataStr } from "./parse-data-str.js";
import { decodeNestedJsonStrings } from "./decode-nested-json.js";
import { flattenRanksSummary, flattenRankDetail } from "./flatten-rank-stats.js";

export async function nodeDetails(
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

  const inner = parseDataStr<{ statistics_map?: Record<string, unknown> }>(
    parsed.data_str,
    rawText,
  );
  if (!inner.ok) return inner;

  const rawMap: Record<string, unknown> = inner.data?.statistics_map ?? {};
  const decoded = decodeNestedJsonStrings(rawMap);

  // Navigate into decoded.ranks for per-rank lookups
  const ranks =
    typeof decoded.ranks === "object" && decoded.ranks !== null
      ? (decoded.ranks as Record<string, unknown>)
      : decoded;

  if (nodeId !== undefined) {
    if (Object.prototype.hasOwnProperty.call(ranks, nodeId)) {
      return {
        ok: true,
        data: flattenRankDetail(ranks[nodeId] as Record<string, unknown>),
      };
    }

    return {
      ok: true,
      data: flattenRanksSummary(decoded),
      note: `node_id '${nodeId}' not found in statistics_map — returning all nodes`,
    };
  }

  return { ok: true, data: flattenRanksSummary(decoded) };
}
