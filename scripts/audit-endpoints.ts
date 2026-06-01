/**
 * Live endpoint audit script.
 *
 * Calls all 15 diagnostic tool functions + SQL queries against a live Kinetica
 * instance and saves raw JSON responses to reports/audit/ for analysis.
 *
 * Table discovery: queries ki_catalog.ki_objects (obj_kind='R') to find real
 * persistent tables, then calls the /show/table REST endpoint for each one
 * to capture Kinetica-native column types and per-column properties.
 *
 * Usage: KINETICA_PASS=<password> npx tsx scripts/audit-endpoints.ts
 *
 * Environment:
 *   KINETICA_PASS  (required — no default; the script exits if unset)
 *   KINETICA_URL   (optional — defaults to http://localhost:9191)
 *   KINETICA_USER  (optional — defaults to "admin")
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { createSession } from "../src/session/KineticaSession.js";
import { healthCheck } from "../src/tools/rest/health.js";
import { getMetrics } from "../src/tools/rest/metrics.js";
import { clusterStatus } from "../src/tools/rest/cluster.js";
import { nodeDetails } from "../src/tools/rest/node.js";
import { getLogs } from "../src/tools/rest/logs.js";
import { showConfiguration } from "../src/tools/rest/show-configuration.js";
import { getSystemProperties } from "../src/tools/rest/system-properties.js";
import { systemTiming } from "../src/tools/rest/system-timing.js";
import { getResourceGroups } from "../src/tools/rest/resource-groups.js";
import { verifyDb } from "../src/tools/rest/verify-db.js";
import { showSecurity } from "../src/tools/rest/security.js";
import { showTable } from "../src/tools/rest/show-table.js";
import { getResourceObjects } from "../src/tools/rest/resource-objects.js";
import { executeSql } from "../src/tools/sql/execute.js";
import { explainQuery } from "../src/tools/sql/explain.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const KINETICA_URL = process.env.KINETICA_URL ?? "http://localhost:9191";
const KINETICA_USER = process.env.KINETICA_USER ?? "admin";
const KINETICA_PASS = process.env.KINETICA_PASS;

if (!KINETICA_PASS) {
  console.error("\n❌ KINETICA_PASS env var is required.");
  console.error("   Usage: KINETICA_PASS=<password> npx tsx scripts/audit-endpoints.ts\n");
  process.exit(1);
}

// Resolve relative to process.cwd() (run from project root)
const AUDIT_DIR = join(process.cwd(), "reports", "audit");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function save(name: string, data: unknown): void {
  const path = join(AUDIT_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  console.log(`  ✓ ${name}.json`);
}

/** Make a filename-safe version of a table name (demo.nyctaxi → demo_nyctaxi) */
function safeName(tableName: string): string {
  return tableName.replace(/[^a-zA-Z0-9_]/g, "_");
}

async function run<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    const elapsed = (performance.now() - start).toFixed(0);
    console.log(`  [${elapsed}ms] ${label}`);
    return result;
  } catch (err) {
    const elapsed = (performance.now() - start).toFixed(0);
    console.error(`  [${elapsed}ms] ${label} — ERROR: ${err}`);
    return { ok: false, error: String(err) } as T;
  }
}

/**
 * Extract schema_name.object_name pairs from a column-oriented SQL result.
 * Works with ki_catalog.ki_objects response shape:
 *   { column_headers: [...], column_1: [...], column_2: [...], ... }
 */
function extractTableNamesFromColumns(result: { ok: boolean; data?: unknown }): readonly string[] {
  if (!result.ok) return [];

  const data = result.data as Record<string, unknown> | undefined;
  if (!data) return [];

  const headers = data.column_headers as string[] | undefined;
  if (!headers) return [];

  const schemaIdx = headers.indexOf("schema_name");
  const nameIdx = headers.indexOf("object_name");
  if (schemaIdx < 0 || nameIdx < 0) return [];

  const schemas = (data[`column_${schemaIdx + 1}`] ?? []) as string[];
  const names = (data[`column_${nameIdx + 1}`] ?? []) as string[];

  return schemas.map((schema, i) => `${schema}.${names[i]}`);
}

// ---------------------------------------------------------------------------
// SQL queries for system tables
// ---------------------------------------------------------------------------

const SYSTEM_TABLE_QUERIES: ReadonlyArray<{ readonly name: string; readonly sql: string }> = [
  {
    name: "sql_ki_query_history",
    sql: "SELECT * FROM ki_catalog.ki_query_history ORDER BY start_time DESC LIMIT 10",
  },
  { name: "sql_ki_query_active_all", sql: "SELECT * FROM ki_catalog.ki_query_active_all LIMIT 20" },
  {
    name: "sql_ki_query_span_metrics_all",
    sql: "SELECT * FROM ki_catalog.ki_query_span_metrics_all LIMIT 10",
  },
  { name: "sql_ki_query_workers", sql: "SELECT * FROM ki_catalog.ki_query_workers LIMIT 20" },
  {
    name: "sql_ki_tiered_objects",
    sql: "SELECT * FROM ki_catalog.ki_tiered_objects ORDER BY size DESC LIMIT 20",
  },
  {
    name: "sql_ki_obj_stat",
    sql: "SELECT * FROM ki_catalog.ki_obj_stat ORDER BY total_bytes DESC LIMIT 30",
  },
  {
    name: "sql_ki_partitions",
    sql: "SELECT * FROM ki_catalog.ki_partitions ORDER BY actual_bytes DESC LIMIT 20",
  },
  {
    name: "sql_ki_objects",
    sql: "SELECT * FROM ki_catalog.ki_objects ORDER BY creation_time DESC LIMIT 30",
  },
  { name: "sql_ki_indexes", sql: "SELECT * FROM ki_catalog.ki_indexes LIMIT 30" },
  { name: "sql_ki_periodic_objects", sql: "SELECT * FROM ki_catalog.ki_periodic_objects LIMIT 20" },
  { name: "sql_ki_depend", sql: "SELECT * FROM ki_catalog.ki_depend LIMIT 30" },
  {
    name: "sql_ki_users_and_roles",
    sql: "SELECT * FROM ki_catalog.ki_users_and_roles ORDER BY name",
  },
  {
    name: "sql_ki_object_permissions",
    sql: "SELECT * FROM ki_catalog.ki_object_permissions ORDER BY object_name LIMIT 50",
  },
  {
    name: "sql_ki_load_history",
    sql: "SELECT * FROM ki_catalog.ki_load_history ORDER BY start_time DESC LIMIT 20",
  },
  {
    name: "sql_ki_backup_history",
    sql: "SELECT * FROM ki_catalog.ki_backup_history ORDER BY start_time DESC LIMIT 20",
  },
  { name: "sql_ki_kafka_lag_info", sql: "SELECT * FROM ki_catalog.ki_kafka_lag_info LIMIT 20" },
  {
    name: "sql_ki_columns_sample",
    sql: "SELECT * FROM ki_catalog.ki_columns WHERE table_name = 'ki_query_history' ORDER BY column_position",
  },
  { name: "sql_ki_datatypes", sql: "SELECT * FROM ki_catalog.ki_datatypes ORDER BY oid" },
  { name: "sql_ki_schemas", sql: "SELECT * FROM ki_catalog.ki_schemas ORDER BY schema_name" },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(AUDIT_DIR, { recursive: true });

  console.log(`\nKinetica Endpoint Audit`);
  console.log(`Target: ${KINETICA_URL}`);
  console.log(`User:   ${KINETICA_USER}`);
  console.log(`Output: ${AUDIT_DIR}\n`);

  const session = createSession(KINETICA_URL, KINETICA_USER, KINETICA_PASS);

  // ------- Connectivity check -------
  console.log("--- Connectivity Check ---");
  const healthResult = await run("health_check", () => healthCheck(session));
  if (!healthResult.ok) {
    console.error(`\n❌ Connectivity check failed: ${(healthResult as { error?: string }).error}`);
    console.error("   Aborting to avoid overwriting existing audit data with errors.\n");
    process.exit(1);
  }
  save("rest_health", healthResult);
  console.log("  ✅ Connected\n");

  // ------- REST diagnostic tools -------
  console.log("--- REST Diagnostic Tools ---");

  const metrics = await run("get_metrics", () => getMetrics(session));
  save("rest_metrics", metrics);

  const cluster = await run("cluster_status", () => clusterStatus(session));
  save("rest_cluster", cluster);

  const node = await run("node_details", () => nodeDetails(session));
  save("rest_node", node);

  const logs = await run("get_logs", () =>
    getLogs(session, { source: "kinetica", min_severity: "ERROR", duration: "1h", limit: 500 }),
  );
  save("rest_logs", logs);

  const config = await run("show_configuration", () => showConfiguration(session, {}));
  save("rest_show_configuration", config);

  const sysProps = await run("system_properties (full)", () => getSystemProperties(session, {}));
  save("rest_system_properties", sysProps);

  const sysPropsFiltered = await run("system_properties (sm_omp)", () =>
    getSystemProperties(session, { key_pattern: "sm_omp" }),
  );
  save("rest_system_properties_filtered", sysPropsFiltered);

  const timing = await run("system_timing", () => systemTiming(session));
  save("rest_timing", timing);

  const resourceGroups = await run("resource_groups", () =>
    getResourceGroups(session, { names: [""], show_tier_usage: true }),
  );
  save("rest_resource_groups", resourceGroups);

  const verifyResult = await run("verify_db", () =>
    verifyDb(session, { verify_nulls: true, verify_persist: true, verify_rank0: true }),
  );
  save("rest_verify_db", verifyResult);

  const security = await run("show_security", () => showSecurity(session, { names: [""] }));
  save("rest_security", security);

  const tableList = await run("show_table (all)", () =>
    showTable(session, { table_name: "", get_sizes: true }),
  );
  save("rest_show_table_list", tableList);

  const resourceObjects = await run("resource_objects", () =>
    getResourceObjects(session, { table_names: "*", limit: 100 }),
  );
  save("rest_resource_objects", resourceObjects);

  // ------- SQL tools -------
  console.log("\n--- SQL Diagnostic Tools ---");

  const explainResult = await run("explain_query", () =>
    explainQuery(session, "SELECT * FROM ki_catalog.ki_query_history LIMIT 1"),
  );
  save("sql_explain", explainResult);

  // ------- System table queries -------
  console.log("\n--- System Table Queries ---");

  for (const q of SYSTEM_TABLE_QUERIES) {
    const result = await run(q.name, () => executeSql(session, q.sql, 100));
    save(q.name, result);
  }

  // ------- Discover tables via ki_catalog.ki_objects -------
  // Uses the authoritative object registry to find persistent tables (obj_kind='R')
  // then calls the /show/table REST endpoint for each to get native column types.
  console.log("\n--- Show Table Detail (discovered from ki_catalog.ki_objects) ---");

  const discoveryResult = await run("discover tables from ki_objects", () =>
    executeSql(
      session,
      "SELECT schema_name, object_name FROM ki_catalog.ki_objects WHERE obj_kind = 'R' AND persistence = 'P' ORDER BY schema_name, object_name LIMIT 20",
      20,
    ),
  );
  save("sql_table_discovery", discoveryResult);

  const discoveredTables = extractTableNamesFromColumns(discoveryResult);
  console.log(`  Found ${discoveredTables.length} persistent tables`);

  for (const fullName of discoveredTables) {
    const detail = await run(`show_table REST endpoint → ${fullName}`, () =>
      showTable(session, { table_name: fullName, get_sizes: true, get_column_info: true }),
    );
    save(`rest_show_table_detail_${safeName(fullName)}`, detail);
  }

  // ------- Raw REST responses (for shape analysis) -------
  console.log("\n--- Raw REST Responses (for shape analysis) ---");

  const rawEndpoints: ReadonlyArray<{
    readonly name: string;
    readonly endpoint: string;
    readonly body: unknown;
  }> = [
    { name: "raw_show_system_status", endpoint: "/show/system/status", body: {} },
    {
      name: "raw_show_resource_statistics",
      endpoint: "/show/resource/statistics",
      body: { options: {} },
    },
    { name: "raw_show_system_timing", endpoint: "/show/system/timing", body: {} },
    { name: "raw_show_system_properties", endpoint: "/show/system/properties", body: {} },
    {
      name: "raw_show_resourcegroups",
      endpoint: "/show/resourcegroups",
      body: {
        names: [""],
        options: {
          show_tier_usage: "true",
          show_default_values: "true",
          show_default_group: "true",
        },
      },
    },
    {
      name: "raw_admin_verifydb",
      endpoint: "/admin/verifydb",
      body: {
        options: {
          concurrent_safe: "true",
          verify_nulls: "true",
          verify_persist: "true",
          verify_rank0: "true",
        },
      },
    },
    { name: "raw_show_security", endpoint: "/show/security", body: { names: [""], options: {} } },
    {
      name: "raw_show_table_list",
      endpoint: "/show/table",
      body: { table_name: "", options: { get_sizes: "true" } },
    },
    {
      name: "raw_show_resource_objects",
      endpoint: "/show/resource/objects",
      body: { options: { table_names: "*", limit: "100" } },
    },
    {
      name: "raw_admin_show_cluster_ops",
      endpoint: "/admin/show/cluster/operations",
      body: { options: {} },
    },
    { name: "raw_admin_show_shards", endpoint: "/admin/show/shards", body: { options: {} } },
    {
      name: "raw_admin_show_jobs",
      endpoint: "/admin/show/jobs",
      body: { options: { show_async_jobs: "true", show_worker_info: "true" } },
    },
  ];

  for (const ep of rawEndpoints) {
    const result = await run(ep.name, async () => {
      const resp = await session.makeRequest(ep.endpoint, ep.body);
      const text = await resp.text();
      try {
        return JSON.parse(text);
      } catch {
        return { raw_text: text, status: resp.status };
      }
    });
    save(ep.name, result);
  }

  console.log("\n✅ Audit complete. Files saved to reports/audit/\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
