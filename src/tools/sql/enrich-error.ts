/**
 * Enriches SQL error messages with verified column names when the error
 * references a ki_catalog table whose schema was discovered at startup.
 *
 * Pure function — returns a new string, never mutates the input.
 */

import type { CatalogSchemas } from "../../agent/discover-schemas.js";

/**
 * Regex to extract table name from `FROM ki_catalog.<table>` or
 * `JOIN ki_catalog.<table>`. Captures the table name, stopping at
 * whitespace, comma, or end of string (handles aliases like `t`).
 */
const KI_CATALOG_TABLE_RE = /(?:FROM|JOIN)\s+ki_catalog\.(\w+)/i;

/**
 * If the SQL statement references a ki_catalog table found in `schemas`,
 * appends the verified column list to the error message. Otherwise returns
 * the original error unchanged.
 */
export function enrichSqlError(
  error: string,
  statement: string,
  schemas: CatalogSchemas | undefined,
): string {
  if (!schemas) return error;

  const match = KI_CATALOG_TABLE_RE.exec(statement);
  if (!match) return error;

  const tableName = match[1];
  const columns = schemas.tables.get(tableName);
  if (!columns) return error;

  return `${error}\n\nVerified columns for ${tableName}: ${columns.join(", ")}`;
}
