/**
 * Pre-flight schema discovery for Kinetica system catalog tables.
 *
 * Queries ki_catalog.ki_columns at startup to discover the actual column
 * names for diagnostic system tables. This ensures the system prompt always
 * references correct column names regardless of Kinetica version.
 *
 * Never throws — returns undefined on any error for graceful degradation.
 */

import type { KineticaSession } from "../types/index.js";
import { executeSql } from "../tools/sql/execute.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CatalogSchemas {
  readonly tables: ReadonlyMap<string, readonly string[]>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** System tables whose schemas we discover at startup. */
const TARGET_TABLES = [
  "ki_query_history",
  "ki_query_active_all",
  "ki_query_span_metrics_all",
  "ki_query_workers",
  "ki_tiered_objects",
  "ki_obj_stat",
  "ki_partitions",
  "ki_objects",
  "ki_indexes",
  "ki_periodic_objects",
  "ki_depend",
  "ki_users_and_roles",
  "ki_object_permissions",
  "ki_load_history",
  "ki_backup_history",
  "ki_kafka_lag_info",
  "ki_columns",
  "ki_datatypes",
] as const;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discovers column names for key system catalog tables by querying
 * ki_catalog.ki_columns. Returns undefined on any error so the agent
 * can fall back to static SQL examples in the system prompt.
 */
export async function discoverCatalogSchemas(
  session: KineticaSession,
): Promise<CatalogSchemas | undefined> {
  try {
    const tableList = TARGET_TABLES.map((t) => `'${t}'`).join(", ");
    const statement = `SELECT table_name, column_name FROM ki_catalog.ki_columns WHERE table_name IN (${tableList}) ORDER BY table_name, column_name`;

    const result = await executeSql(session, statement, 1000);

    if (!result.ok) {
      return undefined;
    }

    const rows = result.data as ReadonlyArray<{
      readonly table_name: string;
      readonly column_name: string;
    }>;

    if (rows.length === 0) {
      return undefined;
    }

    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const existing = grouped.get(row.table_name) ?? [];
      grouped.set(row.table_name, [...existing, row.column_name]);
    }

    return { tables: grouped };
  } catch {
    return undefined;
  }
}
