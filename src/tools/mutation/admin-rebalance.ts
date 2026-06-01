/**
 * adminRebalance — triggers a shard rebalance operation with curated safe parameters.
 *
 * Endpoint: POST /admin/rebalance
 *
 * Safety: Only exposes a curated subset of safe parameters. The dangerous
 *   `repair_incorrectly_sharded_data` option is intentionally excluded from
 *   the schema and never passed to the server.
 * Aggressiveness is capped at 5 via Zod validation.
 *
 * Captures before/after state from /show/system/status for comparison.
 * Before-state failure is non-blocking — rebalance proceeds with empty before_state.
 *
 * Returns: { info, before_state, after_state, verification } from data_str.
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import { z } from "zod";
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { parseDataStr } from "../rest/parse-data-str.js";

/**
 * Curated safe parameter schema for admin-rebalance.
 * NOTE: repair_incorrectly_sharded_data is intentionally NOT in this schema.
 */
export const AdminRebalanceSchema = z.object({
  rebalance_sharded_data: z.boolean().optional(),
  rebalance_unsharded_data: z.boolean().optional(),
  table_includes: z.string().optional(),
  table_excludes: z.string().optional(),
  aggressiveness: z.number().int().min(1).max(5).optional(),
  compact_after_rebalance: z.boolean().optional(),
  compact_only: z.boolean().optional(),
});

export type AdminRebalanceInput = z.infer<typeof AdminRebalanceSchema>;

type AdminRebalanceData = {
  readonly info: Record<string, string>;
  readonly before_state: Record<string, unknown>;
  readonly after_state: Record<string, unknown>;
  readonly verification: "confirmed" | "unavailable";
};

type AdminRebalanceResponse = {
  data_str?: string;
};

type AdminRebalanceInner = {
  info?: Record<string, string>;
};

type SystemStatusResponse = {
  data_str?: string;
};

type SystemStatusInner = {
  shard_map?: Record<string, unknown>;
  db_status?: string;
  [key: string]: unknown;
};

/**
 * Reads the shard summary from /show/system/status.
 * Returns an empty object on any failure — non-blocking.
 */
async function readShardState(session: KineticaSession): Promise<Record<string, unknown>> {
  try {
    const response = await session.makeRequest("/show/system/status", {});
    if (!response.ok) return {};

    const raw = await response.text();
    let parsed: SystemStatusResponse;
    try {
      parsed = JSON.parse(raw) as SystemStatusResponse;
    } catch {
      return {};
    }

    const inner = parseDataStr<SystemStatusInner>(parsed.data_str, raw);
    if (!inner.ok || !inner.data) return {};

    // Extract a compact shard summary
    const data = inner.data;
    return {
      shard_map: data.shard_map ?? {},
      db_status: data.db_status ?? "unknown",
    };
  } catch {
    return {};
  }
}

/**
 * Triggers a shard rebalance operation with curated safe parameters.
 *
 * SAFETY: repair_incorrectly_sharded_data is never included in the options map.
 * It cannot appear because it is not in AdminRebalanceSchema.
 *
 * @param session - Pre-authenticated Kinetica session
 * @param input   - Optional rebalance parameters (all safe, aggressiveness capped at 5)
 * @returns ToolResult with info, before_state, after_state, verification
 */
export async function adminRebalance(
  session: KineticaSession,
  input: AdminRebalanceInput,
): Promise<ToolResult<AdminRebalanceData>> {
  // Capture before-state — failure is non-blocking
  const beforeState = await readShardState(session);

  // Build safe options map — iterate over schema fields, skip undefined values
  const options: Record<string, string> = {};

  if (input.rebalance_sharded_data !== undefined) {
    options.rebalance_sharded_data = String(input.rebalance_sharded_data);
  }
  if (input.rebalance_unsharded_data !== undefined) {
    options.rebalance_unsharded_data = String(input.rebalance_unsharded_data);
  }
  if (input.table_includes !== undefined) {
    options.table_includes = input.table_includes;
  }
  if (input.table_excludes !== undefined) {
    options.table_excludes = input.table_excludes;
  }
  if (input.aggressiveness !== undefined) {
    options.aggressiveness = String(input.aggressiveness);
  }
  if (input.compact_after_rebalance !== undefined) {
    options.compact_after_rebalance = String(input.compact_after_rebalance);
  }
  if (input.compact_only !== undefined) {
    options.compact_only = String(input.compact_only);
  }
  // NOTE: repair_incorrectly_sharded_data is intentionally excluded here.

  try {
    const response = await session.makeRequest("/admin/rebalance", { options });

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
    let parsed: AdminRebalanceResponse;
    try {
      parsed = JSON.parse(raw) as AdminRebalanceResponse;
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      return {
        ok: false,
        status: 200,
        error: `JSON parse error: ${message}`,
        raw,
      };
    }

    const inner = parseDataStr<AdminRebalanceInner>(parsed.data_str, raw);
    if (!inner.ok) return inner;

    const info: Record<string, string> = inner.data?.info ?? {};

    // Capture after-state for verification comparison
    const afterState = await readShardState(session);
    const verification: "confirmed" | "unavailable" =
      Object.keys(afterState).length > 0 ? "confirmed" : "unavailable";

    const data: AdminRebalanceData = {
      info,
      before_state: beforeState,
      after_state: afterState,
      verification,
    };

    return { ok: true, data };
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
