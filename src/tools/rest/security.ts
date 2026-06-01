/**
 * showSecurity — retrieves Kinetica security configuration.
 *
 * Endpoint: POST /show/security
 * Returns: data_str containing types, roles, permissions, and resource_groups maps.
 *
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import { z } from "zod";
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { parseDataStr } from "./parse-data-str.js";

/**
 * Zod schema for showSecurity input parameters.
 * Exported for MCP tool registration.
 */
export const ShowSecuritySchema = z.object({
  names: z.array(z.string()).optional().default([""]),
});

/** Input type inferred from ShowSecuritySchema */
export type ShowSecurityInput = z.infer<typeof ShowSecuritySchema>;

type SecurityResponse = {
  data_str?: string;
};

/**
 * Shows security configuration: user types, roles, permissions, and
 * resource group assignments.
 *
 * @param session - Pre-authenticated Kinetica session
 * @param input   - Optional names filter (users/roles to inspect)
 * @returns ToolResult with data_str containing security maps
 */
export async function showSecurity(
  session: KineticaSession,
  input: ShowSecurityInput,
): Promise<ToolResult<unknown>> {
  try {
    const response = await session.makeRequest("/show/security", {
      names: input.names,
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
    let parsed: SecurityResponse;
    try {
      parsed = JSON.parse(raw) as SecurityResponse;
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
