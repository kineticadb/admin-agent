/**
 * getResourceObjects — shows per-rank resource tier usage for objects.
 *
 * Endpoint: POST /show/resource/objects
 * Returns: data_str containing rank_objects nested map showing object
 * placement across storage tiers (VRAM, RAM, DISK, PERSIST).
 *
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import { z } from "zod";
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { parseDataStr } from "./parse-data-str.js";

/**
 * Zod schema for getResourceObjects input parameters.
 * Exported for MCP tool registration.
 */
export const ResourceObjectsSchema = z.object({
  table_names: z.string().optional().default("*"),
  tiers: z.string().optional(),
  order_by: z.string().optional(),
  limit: z.number().int().min(1).max(10000).optional().default(100),
});

/** Input type inferred from ResourceObjectsSchema */
export type ResourceObjectsInput = z.infer<typeof ResourceObjectsSchema>;

type ResourceObjectsResponse = {
  data_str?: string;
};

/**
 * Shows resource tier usage per rank.
 * Returns object placement across storage tiers.
 *
 * @param session - Pre-authenticated Kinetica session
 * @param input   - Optional filters: table_names, tiers, order_by, limit
 * @returns ToolResult with data_str containing rank_objects nested map
 */
export async function getResourceObjects(
  session: KineticaSession,
  input: ResourceObjectsInput,
): Promise<ToolResult<unknown>> {
  // Build options — use defensive defaults in case caller bypasses Zod parse
  const options: Record<string, string> = {
    table_names: input.table_names ?? "*",
    limit: String(input.limit ?? 100),
  };

  if (input.tiers !== undefined) {
    options.tiers = input.tiers;
  }
  if (input.order_by !== undefined) {
    options.order_by = input.order_by;
  }

  try {
    const response = await session.makeRequest("/show/resource/objects", {
      options,
    });

    if (!response.ok) {
      const raw = await response.text();
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        raw,
      };
    }

    const raw = await response.text();
    let parsed: ResourceObjectsResponse;
    try {
      parsed = JSON.parse(raw) as ResourceObjectsResponse;
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      return {
        ok: false,
        status: 200,
        error: `JSON parse error: ${message}`,
        raw,
      };
    }

    const inner = parseDataStr<unknown>(parsed.data_str, raw);
    if (!inner.ok) return inner;

    return {
      ok: true,
      data: inner.data ?? {},
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      error: message,
      raw: "",
    };
  }
}
