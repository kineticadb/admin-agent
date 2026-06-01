/**
 * verifyDb — runs a read-only database integrity verification.
 *
 * Endpoint: POST /admin/verifydb
 * Safety: Always forces concurrent_safe:true. Never exposes
 *   delete_orphaned_tables or rebuild_on_error to callers.
 *
 * Returns: { verified_ok, error_list, orphaned_tables_total_size } from data_str.
 *
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import { z } from "zod";
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { parseDataStr } from "./parse-data-str.js";

/**
 * Zod schema for verifyDb input parameters.
 * Exported for MCP tool registration.
 */
export const VerifyDbSchema = z.object({
  verify_nulls: z.boolean().optional(),
  verify_persist: z.boolean().optional(),
  verify_rank0: z.boolean().optional(),
});

/** Input type inferred from VerifyDbSchema */
export type VerifyDbInput = z.infer<typeof VerifyDbSchema>;

type VerifyDbData = {
  readonly verified_ok: boolean;
  readonly error_list: readonly unknown[];
  readonly orphaned_tables_total_size: number;
};

type VerifyDbResponse = {
  data_str?: string;
};

type VerifyDbInner = {
  verified_ok?: boolean;
  error_list?: unknown[];
  orphaned_tables_total_size?: number;
};

/**
 * Runs a read-only database integrity verification.
 *
 * SAFETY: concurrent_safe is always hardcoded to "true".
 * delete_orphaned_tables and rebuild_on_error are never included.
 *
 * @param session - Pre-authenticated Kinetica session
 * @param input   - Optional verification flags (nulls, persistence, rank0)
 * @returns ToolResult with verified_ok, error_list, orphaned_tables_total_size
 */
export async function verifyDb(
  session: KineticaSession,
  input: VerifyDbInput,
): Promise<ToolResult<unknown>> {
  // Build safe options — concurrent_safe always hardcoded, dangerous options excluded
  const options: Record<string, string> = {
    concurrent_safe: "true",
  };

  // Only map the 3 allowed boolean params
  if (input.verify_nulls !== undefined) {
    options.verify_nulls = String(input.verify_nulls);
  }
  if (input.verify_persist !== undefined) {
    options.verify_persist = String(input.verify_persist);
  }
  if (input.verify_rank0 !== undefined) {
    options.verify_rank0 = String(input.verify_rank0);
  }

  try {
    const response = await session.makeRequest("/admin/verifydb", { options });

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
    let parsed: VerifyDbResponse;
    try {
      parsed = JSON.parse(raw) as VerifyDbResponse;
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      return {
        ok: false,
        status: 200,
        error: `JSON parse error: ${message}`,
        raw,
      };
    }

    const inner = parseDataStr<VerifyDbInner>(parsed.data_str, raw);
    if (!inner.ok) return inner;

    const data: VerifyDbData = {
      verified_ok: inner.data?.verified_ok ?? false,
      error_list: inner.data?.error_list ?? [],
      orphaned_tables_total_size: inner.data?.orphaned_tables_total_size ?? 0,
    };

    return {
      ok: true,
      data,
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
