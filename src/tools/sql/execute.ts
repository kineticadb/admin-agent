/**
 * SQL execution tool for read-only diagnostic queries.
 *
 * Enforces a read-only guard (isReadOnlySql) before any network call.
 * Handles Kinetica's double-encoded JSON response format.
 * Never throws — all error paths return ToolResult with ok: false.
 */

import { z } from "zod";
import type { KineticaSession, ToolResult } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Zod schema — exported for Plan 02-05 MCP registration
// ---------------------------------------------------------------------------

export const ExecuteSqlSchema = z.object({
  statement: z.string().min(1),
  limit: z.number().int().min(1).max(10000).default(100),
});

export type ExecuteSqlInput = z.infer<typeof ExecuteSqlSchema>;

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------

const READ_ONLY_PREFIXES = /^\s*(SELECT|EXPLAIN|DESCRIBE|DESC)\b/i;

// Matches SQL block comments (slash-star ... star-slash) and line comments (-- ...).
const SQL_COMMENTS = /\/\*[\s\S]*?\*\/|--[^\n]*/g;

/**
 * For WITH (CTE) statements, extracts the final statement after all CTEs
 * and checks that it begins with SELECT. Prevents WITH ... DELETE/INSERT/UPDATE.
 *
 * Strategy: find the last unparenthesized keyword after WITH ... AS (...).
 * We strip comments, then walk forward past balanced parentheses in the CTE
 * definitions to find the final statement.
 */
function isCteReadOnly(stripped: string): boolean {
  // Find the final SQL statement after all CTE definitions.
  // CTEs are: WITH name AS (...), name AS (...) <final-statement>
  // We need to skip past all balanced parentheses to find the final statement.
  let depth = 0;
  let pastFirstParen = false;
  let finalStart = -1;

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "(") {
      depth++;
      pastFirstParen = true;
    } else if (ch === ")") {
      depth--;
      // When depth returns to 0 after being inside parens, we're past a CTE body.
      // The final statement starts after the last depth-0 ")" followed by
      // optional whitespace/comma and then a non-CTE keyword.
      if (depth === 0 && pastFirstParen) {
        finalStart = i + 1;
      }
    }
  }

  if (finalStart === -1) {
    // No balanced parentheses found — not a valid CTE, reject
    return false;
  }

  const tail = stripped.slice(finalStart).trim();
  // The final statement must start with SELECT (or EXPLAIN/DESCRIBE)
  return READ_ONLY_PREFIXES.test(tail);
}

/**
 * Returns true if the statement is allowed (SELECT, WITH+SELECT, or EXPLAIN).
 * Strips SQL comments before checking to prevent bypass via block/line comments.
 * For WITH (CTE) statements, verifies the final statement is a SELECT.
 */
export function isReadOnlySql(statement: string): boolean {
  // Strip SQL comments to prevent bypass vectors
  const stripped = statement.replace(SQL_COMMENTS, " ").trim();

  // Check for simple read-only prefixes (SELECT, EXPLAIN, DESCRIBE, DESC)
  if (READ_ONLY_PREFIXES.test(stripped)) {
    return true;
  }

  // Check for WITH (CTE) — must verify the final statement is a SELECT
  if (/^\s*WITH\b/i.test(stripped)) {
    return isCteReadOnly(stripped);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Kinetica /execute/sql response shape
// ---------------------------------------------------------------------------

interface KineticaSqlDataStr {
  readonly count_affected: number;
  readonly json_encoded_response: string;
  readonly total_number_of_records: number;
  readonly has_more_records: boolean;
  readonly info: Record<string, string>;
}

interface KineticaSqlOuterResponse {
  readonly status: "OK" | "ERROR";
  readonly message: string;
  readonly data_type: string;
  /** Kinetica returns data_str as a JSON-encoded string (double-encoding). */
  readonly data_str: string;
}

// ---------------------------------------------------------------------------
// executeSql
// ---------------------------------------------------------------------------

/**
 * Executes a read-only SQL statement against Kinetica's /execute/sql endpoint.
 *
 * Steps:
 * 1. Pre-flight: reject any non-SELECT/WITH/EXPLAIN statement without a network call.
 * 2. POST /execute/sql with statement, offset 0, limit, encoding "json".
 * 3. Parse outer response (JSON string → KineticaSqlOuterResponse).
 * 4. If outer.status is ERROR, return ok:false with the error message.
 * 5. Parse inner json_encoded_response (another JSON string → rows array).
 * 6. Return ok:true with data and rowCount (note added for zero-row results).
 */
export async function executeSql(
  session: KineticaSession,
  statement: string,
  limit = 100,
): Promise<ToolResult<unknown>> {
  // Step 1: Pre-flight read-only check
  if (!isReadOnlySql(statement)) {
    return {
      ok: false,
      status: 400,
      error: "SQL rejected: only SELECT, WITH, and EXPLAIN statements are permitted",
      raw: statement,
    };
  }

  // Step 2: Network call
  let response: Response;
  let rawText: string;
  try {
    response = await session.makeRequest("/execute/sql", {
      statement,
      offset: 0,
      limit,
      encoding: "json",
      options: {},
    });
    rawText = await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: message, raw: "" };
  }

  // Non-200 HTTP
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}`,
      raw: rawText,
    };
  }

  // Step 3: Parse outer JSON
  let outer: KineticaSqlOuterResponse;
  try {
    outer = JSON.parse(rawText) as KineticaSqlOuterResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 200,
      error: `JSON parse error: ${message}`,
      raw: rawText,
    };
  }

  // Step 4: Check outer status
  if (outer.status === "ERROR") {
    return {
      ok: false,
      status: 400,
      error: outer.message,
      raw: rawText,
    };
  }

  // Step 5: Double-decode data_str (JSON string → KineticaSqlDataStr)
  let dataStr: KineticaSqlDataStr;
  try {
    dataStr = JSON.parse(outer.data_str) as KineticaSqlDataStr;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 200,
      error: `data_str parse error: ${message}`,
      raw: rawText,
    };
  }

  // Step 6: Parse inner json_encoded_response
  let rows: unknown;
  try {
    rows = JSON.parse(dataStr.json_encoded_response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 200,
      error: `JSON parse error: ${message}`,
      raw: rawText,
    };
  }

  // Step 7: Return rows
  const totalRecords = dataStr.total_number_of_records;

  if (totalRecords === 0) {
    return {
      ok: true,
      data: [] as unknown[],
      rowCount: 0,
      note: "Query returned 0 rows",
    };
  }

  return {
    ok: true,
    data: rows,
    rowCount: totalRecords,
  };
}
