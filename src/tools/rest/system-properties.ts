/**
 * getSystemProperties -- retrieves Kinetica system configuration properties.
 *
 * Endpoint: POST /show/system/properties
 * Always fetches the full property_map snapshot; filtering is applied post-call.
 *
 * This tool preserves the original getConfig logic (which also called
 * /show/system/properties) after getConfig was repurposed to call
 * /admin/show/config.
 *
 * Never throws -- all error paths return ToolResult with ok:false.
 * Does NOT call formatOutput() -- that is the MCP layer's responsibility.
 */

import { z } from "zod";
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { flatObjectToRows } from "../../output/reshape.js";
import { parseDataStr } from "./parse-data-str.js";

/**
 * Zod schema for getSystemProperties input parameters.
 * Exported for MCP tool registration.
 */
export const GetSystemPropertiesSchema = z.object({
  category: z.string().optional(),
  key_pattern: z.string().optional(),
});

/** Input type inferred from GetSystemPropertiesSchema */
export type GetSystemPropertiesInput = z.infer<typeof GetSystemPropertiesSchema>;

/**
 * Shape of the /show/system/properties response body.
 * Using a narrow type to safely extract property_map.
 */
type SystemPropertiesResponse = {
  status?: string;
  data_str?: string;
};

/**
 * Retrieves Kinetica system configuration properties.
 *
 * @param session - Pre-authenticated Kinetica session
 * @param input   - Optional category prefix or key_pattern substring filter
 * @returns ToolResult with filtered (or full) property_map on success
 */
export async function getSystemProperties(
  session: KineticaSession,
  input: GetSystemPropertiesInput,
): Promise<ToolResult<unknown>> {
  try {
    // Always fetch full snapshot -- filter post-call
    const response = await session.makeRequest("/show/system/properties", {
      options: {},
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
    let parsed: SystemPropertiesResponse;
    try {
      parsed = JSON.parse(raw) as SystemPropertiesResponse;
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      return {
        ok: false,
        status: 200,
        error: `JSON parse error: ${message}`,
        raw,
      };
    }

    // Double-decode: data_str is a JSON-encoded string
    const inner = parseDataStr<{ property_map?: Record<string, string> }>(parsed.data_str, raw);
    if (!inner.ok) return inner;

    // Extract property_map -- default to empty object if missing
    const propertyMap: Record<string, string> = inner.data?.property_map ?? {};

    // Apply filters
    const filteredMap = applyFilters(propertyMap, input);

    return {
      ok: true,
      data: flatObjectToRows(filteredMap, "property", "value"),
      rowCount: Object.keys(filteredMap).length,
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

/**
 * Applies category prefix and/or key_pattern filters to a property map.
 * Returns a new object -- never mutates the input map.
 */
function applyFilters(
  propertyMap: Record<string, string>,
  input: GetSystemPropertiesInput,
): Record<string, string> {
  const { category, key_pattern } = input;

  // No filters -- return as-is (caller passes to flatObjectToRows which creates new objects)
  if (category === undefined && key_pattern === undefined) {
    return propertyMap;
  }

  const patternLower = key_pattern?.toLowerCase();

  return Object.fromEntries(
    Object.entries(propertyMap).filter(([key]) => {
      const matchesCategory = category === undefined || key.startsWith(category);
      const matchesPattern = patternLower === undefined || key.toLowerCase().includes(patternLower);
      return matchesCategory && matchesPattern;
    }),
  );
}
