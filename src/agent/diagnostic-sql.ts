/**
 * Diagnostic SQL builders for Kinetica system catalog tables.
 *
 * Each builder function takes discovered column names and returns a SQL query
 * string. When schema discovery is unavailable, the fallback constant is used
 * instead. The BUILDER_REGISTRY drives both prompt generation and test coverage.
 *
 * Follows immutable patterns: all inputs are readonly, functions return new
 * strings without side effects.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuilderEntry {
  readonly table: string;
  readonly section: string;
  readonly build: (columns: readonly string[]) => string;
  readonly fallback: string;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function has(columns: readonly string[], name: string): boolean {
  return columns.includes(name);
}

// ---------------------------------------------------------------------------
// Fallback SQL constants — used when schema discovery is unavailable
// ---------------------------------------------------------------------------

export const FALLBACK_QUERY_HISTORY_SQL = `-- Slow queries in the last hour
SELECT query_id, user_name, query_text, start_time, stop_time,
       TIMESTAMPDIFF(SECOND, start_time, stop_time) AS elapsed_sec
FROM ki_catalog.ki_query_history
WHERE start_time > NOW() - INTERVAL '1' HOUR
ORDER BY elapsed_sec DESC
LIMIT 20;`;

export const FALLBACK_ACTIVE_QUERIES_SQL = `-- Currently active queries
SELECT query_id, user_name, query_text, start_time, execution_status
FROM ki_catalog.ki_query_active_all
ORDER BY start_time ASC;`;

export const FALLBACK_TIERED_OBJECTS_SQL = `-- Objects in disk tier (potential memory pressure)
-- NOTE: id is a string (e.g. @schema@oid[col][0]), NOT a numeric OID. Filter by table: WHERE id LIKE '%table_name%'
-- For per-table tier placement, prefer kinetica_resource_objects with table_names filter.
SELECT id, tier, size, source_rank, owner_resource_group
FROM ki_catalog.ki_tiered_objects
WHERE tier != 'VRAM'
ORDER BY size DESC
LIMIT 20;`;

export const FALLBACK_OBJ_STAT_SQL = `-- Table sizes and row counts
SELECT object_name, total_bytes, row_count
FROM ki_catalog.ki_obj_stat
ORDER BY total_bytes DESC
LIMIT 30;`;

export const FALLBACK_COLUMNS_SQL = `-- Structural column metadata (use kinetica_show_table for Kinetica-native types)
SELECT c.table_name, c.column_name, c.column_position
FROM ki_catalog.ki_columns c
WHERE c.table_name = '<TABLE_NAME>'
ORDER BY c.column_position;`;

export const FALLBACK_DATATYPES_SQL = `-- Resolve column_type_oid to human-readable type name
SELECT oid, name, sql_typename
FROM ki_catalog.ki_datatypes
ORDER BY oid;`;

export const FALLBACK_QUERY_SPAN_METRICS_SQL = `-- Query span metrics for a specific query
SELECT query_id, span_id, parent_span_id, operator, sql_step,
       metric_data, start_time, stop_time, source_rank
FROM ki_catalog.ki_query_span_metrics_all
WHERE query_id = '<QUERY_ID>'
ORDER BY start_time;`;

export const FALLBACK_QUERY_WORKERS_SQL = `-- Active query workers (non-idle)
SELECT job_id, worker_id, type, status, elapsed_time_ms, source_rank
FROM ki_catalog.ki_query_workers
WHERE status != 'IDLE'
ORDER BY elapsed_time_ms DESC;`;

export const FALLBACK_OBJECTS_SQL = `-- Object registry and metadata
SELECT oid, object_name, schema_name, type_id, persistence, obj_kind,
       creation_time, last_read_time, read_count, write_count
FROM ki_catalog.ki_objects
ORDER BY last_read_time DESC
LIMIT 30;`;

export const FALLBACK_PARTITIONS_SQL = `-- Partition sizes and tier distribution
SELECT oid, object_name, schema_name, rank_num, partition_type,
       partition_id, num_rows, actual_bytes, tier
FROM ki_catalog.ki_partitions
ORDER BY actual_bytes DESC
LIMIT 30;`;

export const FALLBACK_INDEXES_SQL = `-- Index definitions
SELECT oid, object_name, schema_name, index_type, index_columns
FROM ki_catalog.ki_indexes
ORDER BY object_name;`;

export const FALLBACK_PERIODIC_OBJECTS_SQL = `-- Periodic refresh schedules
SELECT oid, object_name, schema_name, last_refresh_time,
       next_refresh_time, additional_info
FROM ki_catalog.ki_periodic_objects
ORDER BY next_refresh_time;`;

export const FALLBACK_USERS_AND_ROLES_SQL = `-- Users and roles
SELECT oid, name, can_login, is_superuser, resource_group
FROM ki_catalog.ki_users_and_roles
ORDER BY name;`;

export const FALLBACK_OBJECT_PERMISSIONS_SQL = `-- Object permissions
SELECT role_name, permission_type, object_type, object_name, with_grant_option
FROM ki_catalog.ki_object_permissions
ORDER BY object_name, role_name;`;

export const FALLBACK_DEPEND_SQL = `-- Object dependency graph
SELECT src_obj_oid, src_obj_kind, dep_obj_oid, dep_obj_kind, mv_oid, dep_kind
FROM ki_catalog.ki_depend;`;

export const FALLBACK_LOAD_HISTORY_SQL = `-- Recent data load history
SELECT table_oid, datasource_oid, user_name, load_kind,
       start_time, end_time, rows_inserted, event_message
FROM ki_catalog.ki_load_history
WHERE start_time > NOW() - INTERVAL '1' HOUR
ORDER BY start_time DESC
LIMIT 20;`;

export const FALLBACK_BACKUP_HISTORY_SQL = `-- Backup history
SELECT backup_name, operation, status, start_time, end_time,
       num_files, num_bytes, num_records
FROM ki_catalog.ki_backup_history
ORDER BY start_time DESC
LIMIT 20;`;

export const FALLBACK_KAFKA_LAG_INFO_SQL = `-- Kafka consumer lag
SELECT datasource_oid, table_oid, schema_name, table_name,
       partition_id, highest_offset, last_committed_offset
FROM ki_catalog.ki_kafka_lag_info
ORDER BY datasource_oid, partition_id;`;

// ---------------------------------------------------------------------------
// Per-table SQL builders — use discovered columns when available
// ---------------------------------------------------------------------------

export function buildQueryHistorySql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const elapsed =
    has(columns, "start_time") && has(columns, "stop_time")
      ? ",\n       TIMESTAMPDIFF(SECOND, start_time, stop_time) AS elapsed_sec"
      : "";
  const where = has(columns, "start_time") ? "\nWHERE start_time > NOW() - INTERVAL '1' HOUR" : "";
  const orderBy =
    has(columns, "start_time") && has(columns, "stop_time")
      ? // Kinetica does not support timestamp arithmetic in ORDER BY; use the elapsed_sec alias instead
        "\nORDER BY elapsed_sec DESC"
      : "";

  return `-- Slow queries in the last hour
SELECT ${select}${elapsed}
FROM ki_catalog.ki_query_history${where}${orderBy}
LIMIT 20;`;
}

export function buildActiveQueriesSql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const orderBy = has(columns, "start_time") ? "\nORDER BY start_time ASC" : "";

  return `-- Currently active queries
SELECT ${select}
FROM ki_catalog.ki_query_active_all${orderBy};`;
}

export function buildTieredObjectsSql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const where = has(columns, "tier") ? "\nWHERE tier != 'VRAM'" : "";
  const orderBy = has(columns, "size") ? "\nORDER BY size DESC" : "";
  const idNote = has(columns, "id")
    ? "\n-- NOTE: id is a string (e.g. @schema@oid[col][0]), NOT a numeric OID. Filter by table: WHERE id LIKE '%table_name%'"
    : "";

  return `-- Objects in disk tier (potential memory pressure)${idNote}
SELECT ${select}
FROM ki_catalog.ki_tiered_objects${where}${orderBy}
LIMIT 20;`;
}

export function buildObjStatSql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const orderBy = has(columns, "total_bytes") ? "\nORDER BY total_bytes DESC" : "";

  return `-- Table sizes and row counts
SELECT ${select}
FROM ki_catalog.ki_obj_stat${orderBy}
LIMIT 30;`;
}

// Structural columns — metadata not available from kinetica_show_table.
// Type-related columns (column_type_oid, column_size, precision, scale) are
// excluded because kinetica_show_table provides authoritative Kinetica-native types.
const STRUCTURAL_COLUMNS = new Set([
  "table_name",
  "column_name",
  "column_position",
  "is_nullable",
  "is_shard_key",
  "is_primary_key",
  "is_dict_encoded",
  "default_value",
  "bytes_on_disk_uncompressed",
  "bytes_on_disk_compressed",
]);

export function buildColumnsSql(columns: readonly string[]): string {
  const filtered = columns.filter((c) => STRUCTURAL_COLUMNS.has(c));
  // Fall back to all columns if none match structural set
  const selectCols = filtered.length > 0 ? filtered : columns;
  const select = selectCols.map((c) => `c.${c}`).join(", ");
  const where = has(selectCols, "table_name") ? "\nWHERE c.table_name = '<TABLE_NAME>'" : "";
  const orderBy = has(selectCols, "column_position")
    ? "\nORDER BY c.column_position"
    : has(selectCols, "column_name")
      ? "\nORDER BY c.column_name"
      : "";

  return `-- Structural column metadata (use kinetica_show_table for Kinetica-native types)
SELECT ${select}
FROM ki_catalog.ki_columns c${where}${orderBy};`;
}

export function buildDatatypesSql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const orderBy = has(columns, "oid") ? "\nORDER BY oid" : "";

  return `-- Resolve column_type_oid to human-readable type name
SELECT ${select}
FROM ki_catalog.ki_datatypes${orderBy};`;
}

export function buildQuerySpanMetricsSql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const where = has(columns, "query_id") ? "\nWHERE query_id = '<QUERY_ID>'" : "";
  const orderBy = has(columns, "start_time") ? "\nORDER BY start_time" : "";

  return `-- Query span metrics for a specific query
SELECT ${select}
FROM ki_catalog.ki_query_span_metrics_all${where}${orderBy};`;
}

export function buildQueryWorkersSql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const where = has(columns, "status") ? "\nWHERE status != 'IDLE'" : "";
  const orderBy = has(columns, "elapsed_time_ms") ? "\nORDER BY elapsed_time_ms DESC" : "";

  return `-- Active query workers (non-idle)
SELECT ${select}
FROM ki_catalog.ki_query_workers${where}${orderBy};`;
}

export function buildObjectsSql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const orderBy = has(columns, "last_read_time")
    ? "\nORDER BY last_read_time DESC"
    : has(columns, "creation_time")
      ? "\nORDER BY creation_time DESC"
      : "";

  return `-- Object registry and metadata
SELECT ${select}
FROM ki_catalog.ki_objects${orderBy}
LIMIT 30;`;
}

export function buildPartitionsSql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const orderBy = has(columns, "actual_bytes") ? "\nORDER BY actual_bytes DESC" : "";

  return `-- Partition sizes and tier distribution
SELECT ${select}
FROM ki_catalog.ki_partitions${orderBy}
LIMIT 30;`;
}

export function buildIndexesSql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const orderBy = has(columns, "object_name") ? "\nORDER BY object_name" : "";

  return `-- Index definitions
SELECT ${select}
FROM ki_catalog.ki_indexes${orderBy};`;
}

export function buildPeriodicObjectsSql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const orderBy = has(columns, "next_refresh_time") ? "\nORDER BY next_refresh_time" : "";

  return `-- Periodic refresh schedules
SELECT ${select}
FROM ki_catalog.ki_periodic_objects${orderBy};`;
}

export function buildUsersAndRolesSql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const orderBy = has(columns, "name") ? "\nORDER BY name" : "";

  return `-- Users and roles
SELECT ${select}
FROM ki_catalog.ki_users_and_roles${orderBy};`;
}

export function buildObjectPermissionsSql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const orderBy =
    has(columns, "object_name") && has(columns, "role_name")
      ? "\nORDER BY object_name, role_name"
      : has(columns, "object_name")
        ? "\nORDER BY object_name"
        : "";

  return `-- Object permissions
SELECT ${select}
FROM ki_catalog.ki_object_permissions${orderBy};`;
}

export function buildDependSql(columns: readonly string[]): string {
  const select = columns.join(", ");

  return `-- Object dependency graph
SELECT ${select}
FROM ki_catalog.ki_depend;`;
}

export function buildLoadHistorySql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const where = has(columns, "start_time") ? "\nWHERE start_time > NOW() - INTERVAL '1' HOUR" : "";
  const orderBy = has(columns, "start_time") ? "\nORDER BY start_time DESC" : "";

  return `-- Recent data load history
SELECT ${select}
FROM ki_catalog.ki_load_history${where}${orderBy}
LIMIT 20;`;
}

export function buildBackupHistorySql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const orderBy = has(columns, "start_time") ? "\nORDER BY start_time DESC" : "";

  return `-- Backup history
SELECT ${select}
FROM ki_catalog.ki_backup_history${orderBy}
LIMIT 20;`;
}

export function buildKafkaLagInfoSql(columns: readonly string[]): string {
  const select = columns.join(", ");
  const orderBy =
    has(columns, "datasource_oid") && has(columns, "partition_id")
      ? "\nORDER BY datasource_oid, partition_id"
      : has(columns, "datasource_oid")
        ? "\nORDER BY datasource_oid"
        : "";

  return `-- Kafka consumer lag
SELECT ${select}
FROM ki_catalog.ki_kafka_lag_info${orderBy};`;
}

// ---------------------------------------------------------------------------
// Builder Registry — drives prompt generation and test coverage
// ---------------------------------------------------------------------------

export const BUILDER_REGISTRY: readonly BuilderEntry[] = [
  // Query History and Performance
  {
    table: "ki_query_history",
    section: "Query History and Performance",
    build: buildQueryHistorySql,
    fallback: FALLBACK_QUERY_HISTORY_SQL,
  },
  {
    table: "ki_query_active_all",
    section: "Query History and Performance",
    build: buildActiveQueriesSql,
    fallback: FALLBACK_ACTIVE_QUERIES_SQL,
  },
  {
    table: "ki_query_span_metrics_all",
    section: "Query History and Performance",
    build: buildQuerySpanMetricsSql,
    fallback: FALLBACK_QUERY_SPAN_METRICS_SQL,
  },
  {
    table: "ki_query_workers",
    section: "Query History and Performance",
    build: buildQueryWorkersSql,
    fallback: FALLBACK_QUERY_WORKERS_SQL,
  },

  // Memory and Storage Tiers
  {
    table: "ki_tiered_objects",
    section: "Memory and Storage Tiers",
    build: buildTieredObjectsSql,
    fallback: FALLBACK_TIERED_OBJECTS_SQL,
  },
  {
    table: "ki_obj_stat",
    section: "Memory and Storage Tiers",
    build: buildObjStatSql,
    fallback: FALLBACK_OBJ_STAT_SQL,
  },
  {
    table: "ki_partitions",
    section: "Memory and Storage Tiers",
    build: buildPartitionsSql,
    fallback: FALLBACK_PARTITIONS_SQL,
  },

  // Object Registry and Metadata
  {
    table: "ki_objects",
    section: "Object Registry and Metadata",
    build: buildObjectsSql,
    fallback: FALLBACK_OBJECTS_SQL,
  },
  {
    table: "ki_indexes",
    section: "Object Registry and Metadata",
    build: buildIndexesSql,
    fallback: FALLBACK_INDEXES_SQL,
  },
  {
    table: "ki_periodic_objects",
    section: "Object Registry and Metadata",
    build: buildPeriodicObjectsSql,
    fallback: FALLBACK_PERIODIC_OBJECTS_SQL,
  },
  {
    table: "ki_depend",
    section: "Object Registry and Metadata",
    build: buildDependSql,
    fallback: FALLBACK_DEPEND_SQL,
  },

  // Security and Access Control
  {
    table: "ki_users_and_roles",
    section: "Security and Access Control",
    build: buildUsersAndRolesSql,
    fallback: FALLBACK_USERS_AND_ROLES_SQL,
  },
  {
    table: "ki_object_permissions",
    section: "Security and Access Control",
    build: buildObjectPermissionsSql,
    fallback: FALLBACK_OBJECT_PERMISSIONS_SQL,
  },

  // Data Ingestion and Operations
  {
    table: "ki_load_history",
    section: "Data Ingestion and Operations",
    build: buildLoadHistorySql,
    fallback: FALLBACK_LOAD_HISTORY_SQL,
  },
  {
    table: "ki_backup_history",
    section: "Data Ingestion and Operations",
    build: buildBackupHistorySql,
    fallback: FALLBACK_BACKUP_HISTORY_SQL,
  },
  {
    table: "ki_kafka_lag_info",
    section: "Data Ingestion and Operations",
    build: buildKafkaLagInfoSql,
    fallback: FALLBACK_KAFKA_LAG_INFO_SQL,
  },

  // Schema Inspection
  {
    table: "ki_columns",
    section: "Schema Inspection",
    build: buildColumnsSql,
    fallback: FALLBACK_COLUMNS_SQL,
  },
  {
    table: "ki_datatypes",
    section: "Schema Inspection",
    build: buildDatatypesSql,
    fallback: FALLBACK_DATATYPES_SQL,
  },
];
