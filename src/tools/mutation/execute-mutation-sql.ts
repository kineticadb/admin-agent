/**
 * executeMutationSql -- SQL mutation tool with DDL deny-list.
 *
 * Allows approved SQL mutations (CREATE INDEX, ALTER TABLE, ALTER SYSTEM,
 * REFRESH MATERIALIZED VIEW) while blocking destructive DDL
 * (DROP, TRUNCATE, DELETE) even through comment injection.
 *
 * Note: ANALYZE TABLE is NOT supported by Kinetica — the /execute/sql
 * endpoint returns a syntax error. The deny-list does not block it (it's
 * not destructive), but the agent should not attempt it. See CLAUDE.md
 * "Kinetica API Quirks" for the full rationale.
 *
 * Calls /execute/sql WITHOUT the read-only guard from executeSql.
 * Uses the same double-encoded response format as executeSql.
 *
 * Never throws -- all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import { z } from "zod";
import type { KineticaSession, ToolResult } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ExecuteMutationSqlSchema = z.object({
  statement: z.string().min(1),
  limit: z.number().int().min(1).max(10000).default(100),
});

export type ExecuteMutationSqlInput = z.infer<typeof ExecuteMutationSqlSchema>;

// ---------------------------------------------------------------------------
// DDL deny-list
// ---------------------------------------------------------------------------

/** Matches block comments and line comments (-- ...\n). */
const SQL_COMMENTS = /\/\*[\s\S]*?\*\/|--[^\n]*/g;

/**
 * Deny-list pattern for destructive statements.
 *
 * Blocked anywhere in the (comment-stripped) statement — not just at the start —
 * so CTE prefixes like `WITH t AS (SELECT 1) DELETE FROM target` cannot bypass.
 *
 * Blocked:
 * - DROP TABLE/SCHEMA/DATABASE/INDEX/VIEW/MATERIALIZED VIEW/PROCEDURE/FUNCTION/SEQUENCE/TYPE
 * - TRUNCATE [TABLE]
 * - DELETE FROM ... and bare DELETE (but NOT DELETE INDEX which is not standard SQL)
 * - UPDATE <target> (but NOT `SELECT ... FOR UPDATE`, which is a lock hint)
 *
 * Trade-off: a literal string containing a banned keyword (e.g. `INSERT INTO t VALUES ('drop table x')`)
 * produces a false positive. Acceptable because this tool is approval-gated and the operator
 * sees the SQL preview before confirmation.
 */
const DENY_LIST_PATTERN =
  /\b(DROP\s+(TABLE|SCHEMA|DATABASE|INDEX|VIEW|MATERIALIZED\s+VIEW|PROCEDURE|FUNCTION|SEQUENCE|TYPE)\b|TRUNCATE(\s+TABLE)?\b|DELETE\s+FROM\b|DELETE\b(?!\s+INDEX)|(?<!FOR\s)UPDATE\s+\w)/i;

/**
 * Returns true if the statement matches the deny-list (must be blocked).
 * Strips SQL comments before checking to prevent comment-injection bypasses.
 * Scans the whole statement (not just the prefix) so CTE-wrapped DML is caught.
 *
 * @param statement - SQL statement to evaluate
 * @returns true if the statement should be rejected
 */
export function isDeniedMutationSql(statement: string): boolean {
  const stripped = statement.replace(SQL_COMMENTS, " ").trim();
  return DENY_LIST_PATTERN.test(stripped);
}

// ---------------------------------------------------------------------------
// Kinetica /execute/sql response shape (double-encoded)
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
  readonly data_str: string;
}

type MutationSqlData = {
  readonly rows: unknown;
  readonly total_records: number;
};

// ---------------------------------------------------------------------------
// executeMutationSql
// ---------------------------------------------------------------------------

/**
 * Executes a SQL mutation statement against Kinetica's /execute/sql endpoint.
 *
 * Steps:
 * 1. Pre-flight deny-list check: block DROP, TRUNCATE, DELETE.
 * 2. POST /execute/sql with statement, offset 0, limit, encoding "json".
 * 3. Parse outer response (JSON string → KineticaSqlOuterResponse).
 * 4. If outer.status is ERROR, return ok:false.
 * 5. Parse data_str → parse json_encoded_response.
 * 6. Return ok:true with rows and total_records.
 *
 * Intentionally does NOT call isReadOnlySql() -- that guard blocks mutations.
 *
 * @param session   - Pre-authenticated Kinetica session
 * @param statement - SQL statement to execute
 * @param limit     - Max rows to return (default 100)
 * @returns ToolResult with rows and total_records
 */
export async function executeMutationSql(
  session: KineticaSession,
  statement: string,
  limit = 100,
): Promise<ToolResult<unknown>> {
  // Step 1: Pre-flight deny-list check -- no network call if blocked
  if (isDeniedMutationSql(statement)) {
    return {
      ok: false,
      status: 400,
      error:
        "SQL rejected: destructive statements (DROP, TRUNCATE, DELETE, UPDATE) are not permitted, even inside a CTE",
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

  // Step 5: Double-decode data_str
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

  const data: MutationSqlData = {
    rows,
    total_records: dataStr.total_number_of_records,
  };

  return { ok: true, data };
}
