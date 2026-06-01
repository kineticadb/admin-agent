/**
 * Query EXPLAIN plan tool.
 *
 * Prepends "EXPLAIN " to the statement and delegates to executeSql.
 * No additional logic — explainQuery is a thin wrapper ensuring the
 * EXPLAIN keyword is always present without the caller managing it.
 *
 * NOTE: Callers should pass a plain SELECT/WITH statement (no EXPLAIN prefix).
 * Passing "EXPLAIN SELECT..." will result in "EXPLAIN EXPLAIN SELECT..." which
 * Kinetica will likely reject — this is intentional (caller responsibility).
 */

import { z } from "zod";
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { executeSql } from "./execute.js";

// ---------------------------------------------------------------------------
// Zod schema — exported for Plan 02-05 MCP registration
// ---------------------------------------------------------------------------

export const ExplainQuerySchema = z.object({
  statement: z.string().min(1),
  limit: z.number().int().min(1).max(10000).default(100),
});

export type ExplainQueryInput = z.infer<typeof ExplainQuerySchema>;

// ---------------------------------------------------------------------------
// explainQuery
// ---------------------------------------------------------------------------

/**
 * Returns the execution plan for a SQL statement by prepending EXPLAIN.
 *
 * @param session  Pre-authenticated Kinetica session.
 * @param statement  SQL to explain — should NOT include the EXPLAIN keyword.
 * @param limit  Max rows returned (default 100).
 */
export async function explainQuery(
  session: KineticaSession,
  statement: string,
  limit = 100,
): Promise<ToolResult<unknown>> {
  return executeSql(session, "EXPLAIN " + statement.trimStart(), limit);
}
