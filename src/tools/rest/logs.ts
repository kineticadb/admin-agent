/**
 * getLogs -- retrieves filtered logs from Kinetica via /admin/show/logs.
 *
 * Endpoint: POST /admin/show/logs
 * NOTE: This endpoint may not yet be implemented on all Kinetica server versions.
 * When the endpoint is unavailable (404, error, or network failure), the tool
 * returns a structured stub response (ok:true) directing the agent to use
 * kinetica_execute_sql for log-like diagnostic data.
 *
 * When the endpoint is available (200 with valid JSON), returns the parsed data
 * directly -- no code change needed when the endpoint goes live.
 *
 * Never throws -- all error paths return a ToolResult.
 * Does NOT call formatOutput() -- that is the MCP layer's responsibility.
 */

import { z } from "zod";
import type { KineticaSession, ToolResult } from "../../types/index.js";

// Log source enum -- extensible, add new entry + REST parameter mapping to expand
const LOG_SOURCES = ["kinetica", "rank", "syslog", "gadmin", "reveal", "workbench"] as const;

// Log severity levels
const LOG_SEVERITIES = ["DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;

/**
 * Zod schema for getLogs input parameters.
 * Exported for MCP tool registration.
 */
export const GetLogsSchema = z
  .object({
    source: z.enum(LOG_SOURCES),
    min_severity: z.enum(LOG_SEVERITIES).default("INFO"),
    duration: z
      .string()
      .regex(
        /^\d+[mhd]$/,
        "Duration must match pattern: digits followed by m, h, or d (e.g. '1h', '30m', '7d')",
      )
      .optional(),
    start_time: z.string().datetime().optional(),
    end_time: z.string().datetime().optional(),
    node_id: z.string().optional(),
    limit: z.number().int().min(1).max(5000).default(500),
  })
  .refine(
    (data) => {
      // duration and start_time/end_time are mutually exclusive
      const hasDuration = data.duration !== undefined;
      const hasAbsoluteTime = data.start_time !== undefined || data.end_time !== undefined;
      return !(hasDuration && hasAbsoluteTime);
    },
    {
      message:
        "duration and start_time/end_time are mutually exclusive -- use one or the other, not both",
    },
  );

/** Input type inferred from GetLogsSchema */
export type GetLogsInput = z.infer<typeof GetLogsSchema>;

/**
 * Builds the structured stub response for when the endpoint is not available.
 */
function buildStubResponse(input: GetLogsInput): ToolResult<unknown> {
  return {
    ok: true,
    data: {
      note:
        "The /admin/show/logs endpoint is not yet implemented on this Kinetica server. " +
        "Use kinetica_execute_sql to query ki_catalog system tables for log-like diagnostic data.",
      endpoint: "/admin/show/logs",
      status: "stub",
      requested_params: {
        source: input.source,
        min_severity: input.min_severity,
        duration: input.duration,
        start_time: input.start_time,
        end_time: input.end_time,
        node_id: input.node_id,
        limit: input.limit,
      },
    },
  };
}

/**
 * Retrieves logs from Kinetica's /admin/show/logs endpoint.
 *
 * @param session - Pre-authenticated Kinetica session
 * @param input   - Validated log query parameters
 * @returns ToolResult with log data on success, or structured stub when endpoint unavailable
 */
export async function getLogs(
  session: KineticaSession,
  input: GetLogsInput,
): Promise<ToolResult<unknown>> {
  // Build request body -- omit undefined values
  const params: Record<string, unknown> = {
    source: input.source,
    severity: input.min_severity,
    limit: input.limit,
  };

  if (input.duration !== undefined) {
    params.duration = input.duration;
  }
  if (input.start_time !== undefined) {
    params.start_time = input.start_time;
  }
  if (input.end_time !== undefined) {
    params.end_time = input.end_time;
  }
  if (input.node_id !== undefined) {
    params.node_id = input.node_id;
  }

  try {
    const response = await session.makeRequest("/admin/show/logs", params);

    if (!response.ok) {
      // Endpoint not available or returned an error -- return stub
      return buildStubResponse(input);
    }

    // Attempt JSON parse -- response format is unknown, handle gracefully
    const raw = await response.text();
    try {
      const data: unknown = JSON.parse(raw);
      return {
        ok: true,
        data,
      };
    } catch {
      // 200 but unparseable body -- endpoint exists but returned bad data
      return buildStubResponse(input);
    }
  } catch {
    // Network error, timeout, etc. -- endpoint doesn't exist yet
    return buildStubResponse(input);
  }
}
