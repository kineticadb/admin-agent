/**
 * Tests for diagnostic SQL builders.
 *
 * Covers all 18 builder functions in BUILDER_REGISTRY: conditional WHERE,
 * ORDER BY, and column-aware SELECT for each system catalog table.
 */

import { describe, it, expect } from "vitest";
import {
  has,
  BUILDER_REGISTRY,
  buildQueryHistorySql,
  buildActiveQueriesSql,
  buildTieredObjectsSql,
  buildObjStatSql,
  buildColumnsSql,
  buildDatatypesSql,
  buildQuerySpanMetricsSql,
  buildQueryWorkersSql,
  buildObjectsSql,
  buildPartitionsSql,
  buildIndexesSql,
  buildPeriodicObjectsSql,
  buildUsersAndRolesSql,
  buildObjectPermissionsSql,
  buildDependSql,
  buildLoadHistorySql,
  buildBackupHistorySql,
  buildKafkaLagInfoSql,
} from "./diagnostic-sql.js";

// ---------------------------------------------------------------------------
// has() utility
// ---------------------------------------------------------------------------

describe("has", () => {
  it("returns true when column exists", () => {
    expect(has(["a", "b", "c"], "b")).toBe(true);
  });

  it("returns false when column does not exist", () => {
    expect(has(["a", "b", "c"], "d")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BUILDER_REGISTRY structure
// ---------------------------------------------------------------------------

describe("BUILDER_REGISTRY", () => {
  it("has 18 entries", () => {
    expect(BUILDER_REGISTRY).toHaveLength(18);
  });

  it("every entry has table, section, build function, and fallback string", () => {
    for (const entry of BUILDER_REGISTRY) {
      expect(typeof entry.table).toBe("string");
      expect(typeof entry.section).toBe("string");
      expect(typeof entry.build).toBe("function");
      expect(typeof entry.fallback).toBe("string");
    }
  });

  it("contains all 18 expected table names", () => {
    const tables = BUILDER_REGISTRY.map((e) => e.table);
    expect(tables).toEqual([
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
    ]);
  });

  it("groups entries into 6 sections in correct order", () => {
    const seen: string[] = [];
    for (const entry of BUILDER_REGISTRY) {
      if (!seen.includes(entry.section)) {
        seen.push(entry.section);
      }
    }
    expect(seen).toEqual([
      "Query History and Performance",
      "Memory and Storage Tiers",
      "Object Registry and Metadata",
      "Security and Access Control",
      "Data Ingestion and Operations",
      "Schema Inspection",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Migrated builder tests — ki_query_history
// ---------------------------------------------------------------------------

describe("buildQueryHistorySql", () => {
  it("uses discovered columns in SELECT", () => {
    const sql = buildQueryHistorySql([
      "request_id",
      "submitter",
      "sql_text",
      "start_time",
      "stop_time",
    ]);
    expect(sql).toContain("request_id");
    expect(sql).toContain("submitter");
    expect(sql).toContain("ki_catalog.ki_query_history");
  });

  it("includes TIMESTAMPDIFF when start_time and stop_time exist", () => {
    const sql = buildQueryHistorySql(["query_id", "start_time", "stop_time"]);
    expect(sql).toContain("TIMESTAMPDIFF");
    expect(sql).toContain("ORDER BY elapsed_sec DESC");
  });

  it("includes WHERE when start_time exists", () => {
    const sql = buildQueryHistorySql(["query_id", "start_time", "stop_time"]);
    expect(sql).toContain("WHERE start_time > NOW()");
  });

  it("omits WHERE/ORDER BY when start_time and stop_time are absent", () => {
    const sql = buildQueryHistorySql(["query_id", "user_name", "sql_text"]);
    expect(sql).not.toContain("WHERE start_time");
    expect(sql).not.toContain("ORDER BY stop_time");
    expect(sql).not.toContain("TIMESTAMPDIFF");
  });
});

// ---------------------------------------------------------------------------
// Migrated builder tests — ki_query_active_all
// ---------------------------------------------------------------------------

describe("buildActiveQueriesSql", () => {
  it("includes ORDER BY start_time when column exists", () => {
    const sql = buildActiveQueriesSql(["query_id", "start_time"]);
    expect(sql).toContain("ORDER BY start_time ASC");
  });

  it("omits ORDER BY when start_time is absent", () => {
    const sql = buildActiveQueriesSql(["query_id", "user_name"]);
    expect(sql).not.toContain("ORDER BY");
  });
});

// ---------------------------------------------------------------------------
// Migrated builder tests — ki_tiered_objects
// ---------------------------------------------------------------------------

describe("buildTieredObjectsSql", () => {
  it("includes WHERE and ORDER BY when tier and size exist", () => {
    const sql = buildTieredObjectsSql(["id", "tier", "size", "rank"]);
    expect(sql).toContain("WHERE tier != 'VRAM'");
    expect(sql).toContain("ORDER BY size DESC");
  });

  it("omits WHERE/ORDER BY when tier and size are absent", () => {
    const sql = buildTieredObjectsSql(["object_id", "storage_level", "bytes"]);
    expect(sql).not.toContain("WHERE tier");
    expect(sql).not.toContain("ORDER BY size");
  });

  it("includes id-format warning comment when id column exists", () => {
    const sql = buildTieredObjectsSql(["id", "tier", "size", "source_rank"]);
    expect(sql).toContain("NOT a numeric OID");
    expect(sql).toContain("LIKE '%table_name%'");
  });

  it("omits id-format warning when id column is absent", () => {
    const sql = buildTieredObjectsSql(["tier", "size", "source_rank"]);
    expect(sql).not.toContain("NOT a numeric OID");
  });
});

// ---------------------------------------------------------------------------
// Migrated builder tests — ki_obj_stat
// ---------------------------------------------------------------------------

describe("buildObjStatSql", () => {
  it("includes ORDER BY total_bytes when column exists", () => {
    const sql = buildObjStatSql(["object_name", "total_bytes", "row_count"]);
    expect(sql).toContain("ORDER BY total_bytes DESC");
  });

  it("omits ORDER BY when total_bytes is absent", () => {
    const sql = buildObjStatSql(["object_name", "row_count"]);
    expect(sql).not.toContain("ORDER BY");
  });
});

// ---------------------------------------------------------------------------
// Migrated builder tests — ki_columns
// ---------------------------------------------------------------------------

describe("buildColumnsSql", () => {
  it("prefixes each column with c. alias", () => {
    const sql = buildColumnsSql(["table_name", "column_name", "column_position"]);
    expect(sql).toContain("c.table_name");
    expect(sql).toContain("c.column_name");
    expect(sql).toContain("c.column_position");
  });

  it("includes WHERE when table_name exists", () => {
    const sql = buildColumnsSql(["table_name", "column_name"]);
    expect(sql).toContain("WHERE c.table_name = '<TABLE_NAME>'");
  });

  it("includes ORDER BY c.column_position when column_position exists", () => {
    const sql = buildColumnsSql(["table_name", "column_name", "column_position"]);
    expect(sql).toContain("ORDER BY c.column_position");
  });

  it("falls back to ORDER BY c.column_name when column_position is absent", () => {
    const sql = buildColumnsSql(["table_name", "column_name"]);
    expect(sql).toContain("ORDER BY c.column_name");
  });

  it("omits WHERE when table_name is absent", () => {
    const sql = buildColumnsSql(["column_name", "column_position"]);
    expect(sql).not.toContain("WHERE");
  });

  it("excludes type-related columns from SELECT (structural filtering)", () => {
    const allColumns = [
      "table_name",
      "column_name",
      "column_position",
      "is_nullable",
      "column_type_oid",
      "column_size",
      "precision",
      "scale",
      "is_shard_key",
      "is_dict_encoded",
    ];
    const sql = buildColumnsSql(allColumns);
    // Structural columns should be present
    expect(sql).toContain("c.table_name");
    expect(sql).toContain("c.column_name");
    expect(sql).toContain("c.column_position");
    expect(sql).toContain("c.is_nullable");
    expect(sql).toContain("c.is_shard_key");
    expect(sql).toContain("c.is_dict_encoded");
    // Type-related columns should be excluded
    expect(sql).not.toContain("c.column_type_oid");
    expect(sql).not.toContain("c.column_size");
    expect(sql).not.toContain("c.precision");
    expect(sql).not.toContain("c.scale");
  });

  it("falls back to all columns when no structural columns are found", () => {
    // Edge case: all columns are type-related → fall back to all
    const onlyTypeColumns = ["column_type_oid", "column_size", "precision", "scale"];
    const sql = buildColumnsSql(onlyTypeColumns);
    expect(sql).toContain("c.column_type_oid");
    expect(sql).toContain("c.column_size");
  });

  it("includes comment directing to kinetica_show_table for types", () => {
    const sql = buildColumnsSql(["table_name", "column_name", "column_position"]);
    expect(sql).toContain("kinetica_show_table");
  });
});

// ---------------------------------------------------------------------------
// Migrated builder tests — ki_datatypes
// ---------------------------------------------------------------------------

describe("buildDatatypesSql", () => {
  it("includes ORDER BY oid when oid exists", () => {
    const sql = buildDatatypesSql(["oid", "name", "sql_typename"]);
    expect(sql).toContain("ORDER BY oid");
  });

  it("omits ORDER BY when oid is absent", () => {
    const sql = buildDatatypesSql(["name", "sql_typename"]);
    expect(sql).not.toContain("ORDER BY");
  });
});

// ---------------------------------------------------------------------------
// New builder tests — ki_query_span_metrics_all
// ---------------------------------------------------------------------------

describe("buildQuerySpanMetricsSql", () => {
  it("references ki_catalog.ki_query_span_metrics_all", () => {
    const sql = buildQuerySpanMetricsSql(["query_id", "span_id", "start_time"]);
    expect(sql).toContain("ki_catalog.ki_query_span_metrics_all");
  });

  it("includes WHERE query_id when column exists", () => {
    const sql = buildQuerySpanMetricsSql(["query_id", "span_id", "start_time"]);
    expect(sql).toContain("WHERE query_id = '<QUERY_ID>'");
  });

  it("includes ORDER BY start_time when column exists", () => {
    const sql = buildQuerySpanMetricsSql(["query_id", "span_id", "start_time"]);
    expect(sql).toContain("ORDER BY start_time");
  });

  it("omits WHERE/ORDER BY when columns are absent", () => {
    const sql = buildQuerySpanMetricsSql(["span_id", "operator"]);
    expect(sql).not.toContain("WHERE");
    expect(sql).not.toContain("ORDER BY");
  });
});

// ---------------------------------------------------------------------------
// New builder tests — ki_query_workers
// ---------------------------------------------------------------------------

describe("buildQueryWorkersSql", () => {
  it("references ki_catalog.ki_query_workers", () => {
    const sql = buildQueryWorkersSql(["job_id", "status", "elapsed_time_ms"]);
    expect(sql).toContain("ki_catalog.ki_query_workers");
  });

  it("includes WHERE status != IDLE when status exists", () => {
    const sql = buildQueryWorkersSql(["job_id", "status", "elapsed_time_ms"]);
    expect(sql).toContain("WHERE status != 'IDLE'");
  });

  it("includes ORDER BY elapsed_time_ms DESC when column exists", () => {
    const sql = buildQueryWorkersSql(["job_id", "status", "elapsed_time_ms"]);
    expect(sql).toContain("ORDER BY elapsed_time_ms DESC");
  });

  it("omits WHERE/ORDER BY when columns are absent", () => {
    const sql = buildQueryWorkersSql(["job_id", "worker_id"]);
    expect(sql).not.toContain("WHERE");
    expect(sql).not.toContain("ORDER BY");
  });
});

// ---------------------------------------------------------------------------
// New builder tests — ki_objects
// ---------------------------------------------------------------------------

describe("buildObjectsSql", () => {
  it("references ki_catalog.ki_objects", () => {
    const sql = buildObjectsSql(["oid", "object_name", "last_read_time"]);
    expect(sql).toContain("ki_catalog.ki_objects");
  });

  it("includes ORDER BY last_read_time DESC when column exists", () => {
    const sql = buildObjectsSql(["oid", "object_name", "last_read_time"]);
    expect(sql).toContain("ORDER BY last_read_time DESC");
  });

  it("falls back to ORDER BY creation_time DESC when last_read_time absent", () => {
    const sql = buildObjectsSql(["oid", "object_name", "creation_time"]);
    expect(sql).toContain("ORDER BY creation_time DESC");
  });

  it("omits ORDER BY when both time columns absent", () => {
    const sql = buildObjectsSql(["oid", "object_name"]);
    expect(sql).not.toContain("ORDER BY");
  });

  it("includes LIMIT 30", () => {
    const sql = buildObjectsSql(["oid", "object_name"]);
    expect(sql).toContain("LIMIT 30");
  });
});

// ---------------------------------------------------------------------------
// New builder tests — ki_partitions
// ---------------------------------------------------------------------------

describe("buildPartitionsSql", () => {
  it("references ki_catalog.ki_partitions", () => {
    const sql = buildPartitionsSql(["oid", "object_name", "actual_bytes"]);
    expect(sql).toContain("ki_catalog.ki_partitions");
  });

  it("includes ORDER BY actual_bytes DESC when column exists", () => {
    const sql = buildPartitionsSql(["oid", "object_name", "actual_bytes"]);
    expect(sql).toContain("ORDER BY actual_bytes DESC");
  });

  it("omits ORDER BY when actual_bytes absent", () => {
    const sql = buildPartitionsSql(["oid", "object_name"]);
    expect(sql).not.toContain("ORDER BY");
  });

  it("includes LIMIT 30", () => {
    const sql = buildPartitionsSql(["oid"]);
    expect(sql).toContain("LIMIT 30");
  });
});

// ---------------------------------------------------------------------------
// New builder tests — ki_indexes
// ---------------------------------------------------------------------------

describe("buildIndexesSql", () => {
  it("references ki_catalog.ki_indexes", () => {
    const sql = buildIndexesSql(["oid", "object_name", "index_type"]);
    expect(sql).toContain("ki_catalog.ki_indexes");
  });

  it("includes ORDER BY object_name when column exists", () => {
    const sql = buildIndexesSql(["oid", "object_name", "index_type"]);
    expect(sql).toContain("ORDER BY object_name");
  });

  it("omits ORDER BY when object_name absent", () => {
    const sql = buildIndexesSql(["oid", "index_type"]);
    expect(sql).not.toContain("ORDER BY");
  });
});

// ---------------------------------------------------------------------------
// New builder tests — ki_periodic_objects
// ---------------------------------------------------------------------------

describe("buildPeriodicObjectsSql", () => {
  it("references ki_catalog.ki_periodic_objects", () => {
    const sql = buildPeriodicObjectsSql(["oid", "object_name", "next_refresh_time"]);
    expect(sql).toContain("ki_catalog.ki_periodic_objects");
  });

  it("includes ORDER BY next_refresh_time when column exists", () => {
    const sql = buildPeriodicObjectsSql(["oid", "object_name", "next_refresh_time"]);
    expect(sql).toContain("ORDER BY next_refresh_time");
  });

  it("omits ORDER BY when next_refresh_time absent", () => {
    const sql = buildPeriodicObjectsSql(["oid", "object_name"]);
    expect(sql).not.toContain("ORDER BY");
  });
});

// ---------------------------------------------------------------------------
// New builder tests — ki_users_and_roles
// ---------------------------------------------------------------------------

describe("buildUsersAndRolesSql", () => {
  it("references ki_catalog.ki_users_and_roles", () => {
    const sql = buildUsersAndRolesSql(["oid", "name", "can_login"]);
    expect(sql).toContain("ki_catalog.ki_users_and_roles");
  });

  it("includes ORDER BY name when column exists", () => {
    const sql = buildUsersAndRolesSql(["oid", "name", "can_login"]);
    expect(sql).toContain("ORDER BY name");
  });

  it("omits ORDER BY when name absent", () => {
    const sql = buildUsersAndRolesSql(["oid", "can_login"]);
    expect(sql).not.toContain("ORDER BY");
  });
});

// ---------------------------------------------------------------------------
// New builder tests — ki_object_permissions
// ---------------------------------------------------------------------------

describe("buildObjectPermissionsSql", () => {
  it("references ki_catalog.ki_object_permissions", () => {
    const sql = buildObjectPermissionsSql(["role_name", "object_name", "permission_type"]);
    expect(sql).toContain("ki_catalog.ki_object_permissions");
  });

  it("includes ORDER BY object_name, role_name when both exist", () => {
    const sql = buildObjectPermissionsSql(["role_name", "object_name", "permission_type"]);
    expect(sql).toContain("ORDER BY object_name, role_name");
  });

  it("includes ORDER BY object_name when only object_name exists", () => {
    const sql = buildObjectPermissionsSql(["object_name", "permission_type"]);
    expect(sql).toContain("ORDER BY object_name");
    expect(sql).not.toContain("role_name");
  });

  it("omits ORDER BY when neither column exists", () => {
    const sql = buildObjectPermissionsSql(["permission_type", "grantor"]);
    expect(sql).not.toContain("ORDER BY");
  });
});

// ---------------------------------------------------------------------------
// New builder tests — ki_depend
// ---------------------------------------------------------------------------

describe("buildDependSql", () => {
  it("references ki_catalog.ki_depend", () => {
    const sql = buildDependSql(["src_obj_oid", "dep_obj_oid"]);
    expect(sql).toContain("ki_catalog.ki_depend");
  });

  it("has no ORDER BY (graph data)", () => {
    const sql = buildDependSql(["src_obj_oid", "dep_obj_oid", "dep_kind"]);
    expect(sql).not.toContain("ORDER BY");
  });

  it("uses all discovered columns in SELECT", () => {
    const sql = buildDependSql(["src_obj_oid", "src_obj_kind", "dep_obj_oid", "dep_obj_kind"]);
    expect(sql).toContain("src_obj_oid, src_obj_kind, dep_obj_oid, dep_obj_kind");
  });
});

// ---------------------------------------------------------------------------
// New builder tests — ki_load_history
// ---------------------------------------------------------------------------

describe("buildLoadHistorySql", () => {
  it("references ki_catalog.ki_load_history", () => {
    const sql = buildLoadHistorySql(["table_oid", "start_time", "rows_inserted"]);
    expect(sql).toContain("ki_catalog.ki_load_history");
  });

  it("includes WHERE start_time > 1h ago when start_time exists", () => {
    const sql = buildLoadHistorySql(["table_oid", "start_time"]);
    expect(sql).toContain("WHERE start_time > NOW() - INTERVAL '1' HOUR");
  });

  it("includes ORDER BY start_time DESC when start_time exists", () => {
    const sql = buildLoadHistorySql(["table_oid", "start_time"]);
    expect(sql).toContain("ORDER BY start_time DESC");
  });

  it("omits WHERE/ORDER BY when start_time absent", () => {
    const sql = buildLoadHistorySql(["table_oid", "rows_inserted"]);
    expect(sql).not.toContain("WHERE");
    expect(sql).not.toContain("ORDER BY");
  });

  it("includes LIMIT 20", () => {
    const sql = buildLoadHistorySql(["table_oid"]);
    expect(sql).toContain("LIMIT 20");
  });
});

// ---------------------------------------------------------------------------
// New builder tests — ki_backup_history
// ---------------------------------------------------------------------------

describe("buildBackupHistorySql", () => {
  it("references ki_catalog.ki_backup_history", () => {
    const sql = buildBackupHistorySql(["backup_name", "start_time"]);
    expect(sql).toContain("ki_catalog.ki_backup_history");
  });

  it("includes ORDER BY start_time DESC when start_time exists", () => {
    const sql = buildBackupHistorySql(["backup_name", "start_time"]);
    expect(sql).toContain("ORDER BY start_time DESC");
  });

  it("omits ORDER BY when start_time absent", () => {
    const sql = buildBackupHistorySql(["backup_name", "status"]);
    expect(sql).not.toContain("ORDER BY");
  });

  it("includes LIMIT 20", () => {
    const sql = buildBackupHistorySql(["backup_name"]);
    expect(sql).toContain("LIMIT 20");
  });
});

// ---------------------------------------------------------------------------
// New builder tests — ki_kafka_lag_info
// ---------------------------------------------------------------------------

describe("buildKafkaLagInfoSql", () => {
  it("references ki_catalog.ki_kafka_lag_info", () => {
    const sql = buildKafkaLagInfoSql(["datasource_oid", "partition_id"]);
    expect(sql).toContain("ki_catalog.ki_kafka_lag_info");
  });

  it("includes ORDER BY datasource_oid, partition_id when both exist", () => {
    const sql = buildKafkaLagInfoSql(["datasource_oid", "partition_id", "highest_offset"]);
    expect(sql).toContain("ORDER BY datasource_oid, partition_id");
  });

  it("includes ORDER BY datasource_oid when only datasource_oid exists", () => {
    const sql = buildKafkaLagInfoSql(["datasource_oid", "highest_offset"]);
    expect(sql).toContain("ORDER BY datasource_oid");
    expect(sql).not.toContain("partition_id");
  });

  it("omits ORDER BY when neither column exists", () => {
    const sql = buildKafkaLagInfoSql(["highest_offset", "last_committed_offset"]);
    expect(sql).not.toContain("ORDER BY");
  });
});
