/**
 * getResourceGroups — lists Kinetica resource groups and their configuration.
 *
 * Endpoint: POST /show/resourcegroups
 * Returns: data_str containing groups[] array and optionally rank_usage map.
 * Optionally shows tier usage per rank when show_tier_usage is true.
 *
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import { z } from "zod";
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { parseDataStr } from "./parse-data-str.js";

/**
 * Zod schema for getResourceGroups input parameters.
 * Exported for MCP tool registration.
 */
export const ResourceGroupsSchema = z.object({
  names: z.array(z.string()).optional().default([""]),
  show_tier_usage: z.boolean().optional(),
});

/** Input type inferred from ResourceGroupsSchema */
export type ResourceGroupsInput = z.infer<typeof ResourceGroupsSchema>;

type ResourceGroupsResponse = {
  data_str?: string;
};

/**
 * Lists resource groups and their configuration.
 *
 * @param session - Pre-authenticated Kinetica session
 * @param input   - Optional names filter and tier usage flag
 * @returns ToolResult with data_str containing groups and optionally rank_usage
 */
export async function getResourceGroups(
  session: KineticaSession,
  input: ResourceGroupsInput,
): Promise<ToolResult<unknown>> {
  try {
    const response = await session.makeRequest("/show/resourcegroups", {
      names: input.names,
      options: {
        show_tier_usage: String(input.show_tier_usage ?? false),
        show_default_values: "true",
        show_default_group: "true",
      },
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
    let parsed: ResourceGroupsResponse;
    try {
      parsed = JSON.parse(raw) as ResourceGroupsResponse;
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
