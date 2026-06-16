/**
 * Tool barrel — integration point for all 16 diagnostic + 4 mutation tool functions.
 *
 * Exports:
 *   createDiagnosticRegistry() — returns Registry with all 16 tool names registered as read-only
 *   makeDiagnosticTools(session) — returns array of 16 MCP tool objects for the agent loop
 *   makeMutationTools(session)   — returns array of 4 MCP tool objects for mutation tools
 *
 * Output pipeline applied in every handler: formatOutput(result.ok ? result.data : result) → truncateOutput
 * Diagnostic tools registered with { annotations: { readOnly: true } } annotation.
 * Mutation tools annotated with { destructive: true, readOnly: false } — triggers approval gate.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import pc from "picocolors";

import { createRegistry } from "../approval/registry.js";
import type { Registry } from "../approval/registry.js";
import { formatOutput } from "../output/format.js";
import { formatToolName } from "../output/format-tool-name.js";
import { truncateOutput } from "../output/truncate.js";
import type { KineticaSession } from "../types/index.js";

import { healthCheck } from "./rest/health.js";
import { getMetrics } from "./rest/metrics.js";
import { clusterStatus } from "./rest/cluster.js";
import { nodeDetails } from "./rest/node.js";
import { getLogs, GetLogsSchema } from "./rest/logs.js";
import { showConfiguration, ShowConfigurationSchema } from "./rest/show-configuration.js";
import { getSystemProperties, GetSystemPropertiesSchema } from "./rest/system-properties.js";
import { systemTiming } from "./rest/system-timing.js";
import { getResourceGroups, ResourceGroupsSchema } from "./rest/resource-groups.js";
import { verifyDb, VerifyDbSchema } from "./rest/verify-db.js";
import { showSecurity, ShowSecuritySchema } from "./rest/security.js";
import { showTable, ShowTableSchema } from "./rest/show-table.js";
import { getResourceObjects, ResourceObjectsSchema } from "./rest/resource-objects.js";
import { hostManagerStatus } from "./rest/host-manager.js";
import { executeSql, ExecuteSqlSchema } from "./sql/execute.js";
import { explainQuery, ExplainQuerySchema } from "./sql/explain.js";
import { enrichSqlError } from "./sql/enrich-error.js";
import type { CatalogSchemas } from "../agent/discover-schemas.js";

import {
  alterSystemProperties,
  AlterSystemPropertiesSchema,
} from "./mutation/alter-system-properties.js";
import { executeMutationSql, ExecuteMutationSqlSchema } from "./mutation/execute-mutation-sql.js";
import { adminRebalance, AdminRebalanceSchema } from "./mutation/admin-rebalance.js";
import { alterConfiguration, AlterConfigurationSchema } from "./mutation/alter-configuration.js";
import { makeAlterTableColumnsTool } from "./mutation/alter-table-columns.js";
import { redactAuditInput } from "./audit-redact.js";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const MUTATION_TOOL_NAMES = [
  "kinetica_alter_system_properties",
  "kinetica_execute_mutation_sql",
  "kinetica_admin_rebalance",
  "kinetica_alter_configuration",
] as const;

export const ALTER_TABLE_COLUMNS_TOOL_NAME = "kinetica_alter_table_columns" as const;

export const DIAGNOSTIC_TOOL_NAMES = [
  "kinetica_health_check",
  "kinetica_get_metrics",
  "kinetica_cluster_status",
  "kinetica_node_details",
  "kinetica_get_logs",
  "kinetica_show_configuration",
  "kinetica_get_system_properties",
  "kinetica_execute_sql",
  "kinetica_explain_query",
  "kinetica_system_timing",
  "kinetica_resource_groups",
  "kinetica_verify_db",
  "kinetica_show_security",
  "kinetica_show_table",
  "kinetica_resource_objects",
  "kinetica_host_manager_status",
] as const;

/**
 * Returns a Registry with all 16 diagnostic tool names registered as read-only.
 * The approval gate uses this registry so no user confirmation is required for
 * any diagnostic tool.
 */
export function createDiagnosticRegistry(): Registry {
  return DIAGNOSTIC_TOOL_NAMES.reduce(
    (registry, name) => registry.registerReadOnlyTool(name),
    createRegistry(),
  );
}

// ---------------------------------------------------------------------------
// Output pipeline helper
// ---------------------------------------------------------------------------

/**
 * Apply the standard output pipeline to a ToolResult.
 * On success: formatOutput(result.data), prefixed with `note` when present.
 * On failure: formatOutput(result) — renders the full failure object so the agent
 *             can see HTTP status, error message, and raw response.
 *
 * The `note` is agent-facing guidance set alongside the data (e.g. "results capped
 * — narrow your query", "bundle attached — ask the operator before investigating").
 * It is prepended so it survives truncation (head lines are always kept); without
 * this it was silently dropped and never reached the model.
 */
export function applyOutputPipeline(result: {
  ok: boolean;
  data?: unknown;
  note?: string;
}): string {
  const payload = result.ok ? result.data : result;
  const body = formatOutput(payload);
  const withNote = result.ok && result.note ? `${result.note}\n\n${body}` : body;
  return truncateOutput(withNote);
}

// ---------------------------------------------------------------------------
// Mutation audit logger
// ---------------------------------------------------------------------------

/**
 * Emits a stderr audit line after each mutation tool executes.
 * Logs EXECUTED (success) or FAILED (error) with a summary of the inputs provided.
 * NOTE: This logs after tool execution — the approval gate logs APPROVED/DENIED separately.
 */
export function logMutationAudit(
  toolName: string,
  result: { ok: boolean; data?: unknown },
  input: object,
): void {
  const statusLabel = result.ok ? pc.bold(pc.green("EXECUTED")) : pc.bold(pc.red("FAILED"));
  // Redact known-sensitive fields (config_string), scrub inline credentials
  // (PASSWORD = '...', IDENTIFIED BY '...'), and fingerprint any long string
  // before emitting to stderr. Defense-in-depth — the approval preview still
  // shows the full input to the operator before execution.
  const redacted = redactAuditInput(input as Record<string, unknown>);
  const inputSummary = Object.entries(redacted)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  const displayName = formatToolName(toolName);
  process.stderr.write(
    `  ${pc.dim("MUTATION")} ${statusLabel}  ${displayName}\n  ${pc.dim(inputSummary)}\n\n`,
  );
}

// ---------------------------------------------------------------------------
// Mutation tool factories (NO readOnly annotation — triggers approval gate)
// ---------------------------------------------------------------------------

function makeAlterSystemPropertiesTool(session: KineticaSession) {
  return tool(
    "kinetica_alter_system_properties",
    "Apply runtime configuration changes to Kinetica via /alter/system/properties. Accepts a map of property name to new value. Captures current values before applying and verifies changes after. Only the 43 documented properties are accepted — requests with unsupported property names are rejected before any API call. Blocked for safety: ai_api_key, external_files_directory. Common properties (7.2.x): subtask_concurrency_limit, request_timeout, max_get_records_size, concurrent_kernel_execution, max_concurrent_kernels, tcs_per_tom, tps_per_tom, chunk_size, enable_audit, egress_parquet_compression, background_worker_threads. All property names require 'conf.' prefix in /show/system/properties but NOT in /alter/system/properties.",
    AlterSystemPropertiesSchema.shape,
    async (args: Record<string, unknown>) => {
      const parsed = AlterSystemPropertiesSchema.parse(args);
      const result = await alterSystemProperties(session, parsed);
      logMutationAudit("kinetica_alter_system_properties", result, parsed);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { destructive: true, readOnly: false } },
  );
}

function makeExecuteMutationSqlTool(session: KineticaSession) {
  return tool(
    "kinetica_execute_mutation_sql",
    "Execute a SQL mutation statement on Kinetica (CREATE INDEX, ALTER TABLE, ALTER SYSTEM SET, REFRESH MATERIALIZED VIEW, etc.). ANALYZE TABLE is NOT supported by Kinetica — do not call it. DROP, TRUNCATE, DELETE, and UPDATE are always rejected — even when wrapped in a CTE (WITH ... DELETE/UPDATE). Requires user approval before execution.",
    ExecuteMutationSqlSchema.shape,
    async (args: Record<string, unknown>) => {
      const parsed = ExecuteMutationSqlSchema.parse(args);
      const result = await executeMutationSql(session, parsed.statement, parsed.limit);
      logMutationAudit("kinetica_execute_mutation_sql", result, parsed);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { destructive: true, readOnly: false } },
  );
}

function makeAdminRebalanceTool(session: KineticaSession) {
  return tool(
    "kinetica_admin_rebalance",
    "Trigger shard data rebalancing across Kinetica cluster ranks via /admin/rebalance. Options: rebalance_sharded_data, rebalance_unsharded_data, table_includes, table_excludes, aggressiveness (1-5, capped for safety), compact_after_rebalance, compact_only. Captures before/after shard distribution for verification. WARNING: rebalance causes delayed query responses while running — use low aggressiveness (1-3) during production hours. NOTE: On single-worker-rank clusters, /admin/rebalance returns 'Database must be offline' because there is only one data rank — rebalance is only meaningful with 2+ worker ranks.",
    AdminRebalanceSchema.shape,
    async (args: Record<string, unknown>) => {
      const parsed = AdminRebalanceSchema.parse(args);
      const result = await adminRebalance(session, parsed);
      logMutationAudit("kinetica_admin_rebalance", result, parsed);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { destructive: true, readOnly: false } },
  );
}

function makeAlterConfigurationTool(session: KineticaSession) {
  return tool(
    "kinetica_alter_configuration",
    "Replace the full gpudb.conf configuration on the Kinetica host manager via /admin/alter/configuration (port 9300). Requires the complete config_string content — the entire file is replaced. Captures before/after config summaries for verification. WARNING: This replaces the ENTIRE configuration file. Always read the current config via kinetica_show_configuration first, make targeted changes to specific lines, and submit the full modified content. Never compose a config from scratch. Requires host manager connectivity and user approval.",
    AlterConfigurationSchema.shape,
    async (args: Record<string, unknown>) => {
      const parsed = AlterConfigurationSchema.parse(args);
      const result = await alterConfiguration(session, parsed);
      logMutationAudit("kinetica_alter_configuration", result, parsed);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { destructive: true, readOnly: false } },
  );
}

// ---------------------------------------------------------------------------
// Individual tool factories
// ---------------------------------------------------------------------------

function makeHealthCheckTool(session: KineticaSession) {
  return tool(
    "kinetica_health_check",
    "Query Kinetica system health status via /show/system/status. Returns 11 components as rows (component, status): system (cluster status, leader, offline), ranks (per-rank status/mode/accepting_jobs/read_only), hosts (hostname, memory, GPU IDs, sub-service statuses), http_server (connections current/refused, thread capacity), ha_cluster_info/ha_status, graph, text, migrations, triggers, symbols. NOTE: Each status value is a JSON-encoded string — parse mentally to extract nested fields. Healthy baseline: system.status='running', all ranks rank_status='running' + rank_mode='run', hosts.status='running', http_server.connections.refused=0.",
    {},
    async (_args: Record<string, never>) => {
      const result = await healthCheck(session);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

function makeGetMetricsTool(session: KineticaSession) {
  return tool(
    "kinetica_get_metrics",
    "Retrieve per-rank storage tier metrics from /show/resource/statistics. Returns rows with: rank, ram_used, ram_limit, ram_percent (computed as 'X.Y%' e.g. '9.6%'), persist_used, disk_used, vram_used (all string values). Rank 0 is the head/coordinator node with minimal RAM (~794MB limit) and empty persist/disk/vram fields. Worker ranks (1+) hold the actual data with ~5.6GB RAM limit. Empty string means tier not configured; '0' means configured but unused. Healthy baseline: ram_percent under 80%. Optional node_id to annotate which node was requested.",
    { node_id: z.string().optional() },
    async (args: { node_id?: string }) => {
      const result = await getMetrics(session, args.node_id);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

function makeClusterStatusTool(session: KineticaSession) {
  return tool(
    "kinetica_cluster_status",
    "Get full cluster overview via 4 sub-calls: (1) /admin/show/cluster/operations — in_progress flag, percent_complete, rebalance/add/remove status; (2) /admin/show/shards — summarized as shard distribution per rank (total_shards, rank_count, per-rank shard_count/percent, balanced flag, shard_array_version); (3) /admin/show/alerts on host manager port — recent alerts (gracefully degrades if unavailable); (4) /admin/show/jobs — active async jobs as {job_id, status, endpoint} objects. Healthy baseline: operations.in_progress=false, shards.balanced=true, empty alerts/jobs arrays.",
    {},
    async (_args: Record<string, never>) => {
      const result = await clusterStatus(session);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

function makeNodeDetailsTool(session: KineticaSession) {
  return tool(
    "kinetica_node_details",
    "Get per-rank resource statistics from /show/resource/statistics (same endpoint as kinetica_get_metrics). Without node_id: returns summary rows for all ranks. With node_id: returns detailed tier + resource-group breakdown for that rank. Per-tier fields: limit, used, free, percent_used, num_evictable_objs, num_unevictable_objs, plus stats: evictions, pins, unpins, watermark_cycles, allocs, reallocs, deallocs (RAM/VRAM tiers) or reads, writes, deletes (PERSIST/DISK tiers). Per-resource-group fields: name, thread_running_count, data (bytes). Rank 0 is the head node — only RAM tier (no PERSIST/DISK/VRAM), no resource groups.",
    { node_id: z.string().optional() },
    async (args: { node_id?: string }) => {
      const result = await nodeDetails(session, args.node_id);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

function makeGetLogsTool(session: KineticaSession) {
  return tool(
    "kinetica_get_logs",
    "Retrieve application logs via /admin/show/logs. Sources: kinetica, rank, syslog, gadmin, reveal, workbench. Severity: DEBUG|INFO|WARN|ERROR|FATAL. Time: duration (1h, 30m) or start_time+end_time. WARNING: This endpoint is NOT available on Kinetica 7.2.x — it always returns a stub response. Use kinetica_execute_sql to query ki_catalog.ki_query_history (for query errors) or ki_catalog.ki_query_span_metrics_all (for operation-level events) instead.",
    GetLogsSchema.shape,
    async (args: Record<string, unknown>) => {
      const parsed = GetLogsSchema.parse(args);
      const result = await getLogs(session, parsed);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

function makeShowConfigurationTool(session: KineticaSession) {
  return tool(
    "kinetica_show_configuration",
    "Retrieve the full gpudb.conf configuration file from the Kinetica host manager via /admin/show/configuration (port 9300). Returns the raw config_string in INI format with all sections and comments. Use this to inspect the complete server configuration for drift detection, misconfiguration diagnosis, or before proposing config changes via kinetica_alter_configuration. Requires host manager connectivity.",
    ShowConfigurationSchema.shape,
    async (args: Record<string, unknown>) => {
      const parsed = ShowConfigurationSchema.parse(args);
      const result = await showConfiguration(session, parsed);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

function makeGetSystemPropertiesTool(session: KineticaSession) {
  return tool(
    "kinetica_get_system_properties",
    "Read Kinetica system configuration properties from /show/system/properties. Returns 260+ property rows as {property, value} pairs (all values are strings). Filter by category prefix (e.g., 'conf.tier', 'conf.sql', 'version') or key_pattern substring. Key property groups: conf.tier.* (RAM limits, watermarks, tier strategy), conf.sql.* (parallel_execution, planner timeout), conf.enable_* (authorization, HA, ML, text_search), version.* (gpudb_core_version, compute_engine). Omit both filters to get the full property_map.",
    GetSystemPropertiesSchema.shape,
    async (args: Record<string, unknown>) => {
      const parsed = GetSystemPropertiesSchema.parse(args);
      const result = await getSystemProperties(session, parsed);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

function makeExecuteSqlTool(session: KineticaSession, catalogSchemas?: CatalogSchemas) {
  return tool(
    "kinetica_execute_sql",
    "Execute a read-only SQL query (SELECT, WITH, or EXPLAIN) against Kinetica. Key system tables: ki_catalog.ki_query_history (slow queries — columns: job_id, query_id, user_name, endpoint, execution_status, error_message, query_text, start_time, stop_time, sql_step_count, refresh_id, resource_group, source_ip), ki_catalog.ki_query_active_all (running queries — columns: job_id, query_id, user_name, resource_group, source_ip, endpoint, execution_status, error_message, start_time, query_text, sql_step_count, refresh_id, is_mh, is_perpetual, is_cancellable, is_using_timeout, source_rank), ki_catalog.ki_tiered_objects (per-object tier placement — size, id (string like @schema@oid[col][0] — NOT a numeric OID, do not join with ki_objects.oid), priority, tier, evictable, locked, pin_count, ram_evictions, persist_evictions, owner_resource_group, source_rank, outer_object; for per-table tier data prefer kinetica_resource_objects with table_names filter), ki_catalog.ki_obj_stat (table sizes — oid, schema_name, object_name, row_count, bytes_per_row, total_bytes), ki_catalog.ki_columns (column metadata), ki_catalog.ki_objects (object registry with obj_kind R=table/V=view). WARNING: ki_catalog.ki_tables and ki_catalog.ki_version do NOT exist in Kinetica 7.2.x — use ki_objects and /show/system/status instead.",
    ExecuteSqlSchema.shape,
    async (args: { statement: string; limit?: number }) => {
      const result = await executeSql(session, args.statement, args.limit);
      if (!result.ok) {
        const enrichedError = enrichSqlError(result.error, args.statement, catalogSchemas);
        const enrichedResult =
          enrichedError !== result.error
            ? { ok: false as const, status: result.status, error: enrichedError, raw: result.raw }
            : result;
        return { content: [{ type: "text" as const, text: applyOutputPipeline(enrichedResult) }] };
      }
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

function makeExplainQueryTool(session: KineticaSession) {
  return tool(
    "kinetica_explain_query",
    "Get the execution plan for a SQL statement. Pass the SELECT statement without the EXPLAIN keyword — it will be added automatically. Returns rows with columns: ID (step number), ENDPOINT (internal REST endpoint used, e.g., /get/records/bycolumn), INPUT_TABLES, OUTPUT_TABLE, DEPENDENCIES (step IDs this depends on; -1 means none). Use to understand which internal operations a query triggers and verify index usage.",
    ExplainQuerySchema.shape,
    async (args: { statement: string; limit?: number }) => {
      const result = await explainQuery(session, args.statement, args.limit);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

function makeSystemTimingTool(session: KineticaSession) {
  return tool(
    "kinetica_system_timing",
    "Show endpoint response timing statistics from /show/system/timing. Returns the last ~100 API calls as {endpoint, time_in_ms, job_id} rows with sub-millisecond precision. job_id='0' means synchronous execution at head node; non-zero means async. Typical baselines: /show/system/properties <4ms, /show/security <1ms, /execute/sql 14-1300ms, /admin/verifydb 500-4500ms. Use to identify slow API endpoints or confirm whether a specific call was abnormally slow.",
    {},
    async (_args: Record<string, never>) => {
      const result = await systemTiming(session);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

function makeResourceGroupsTool(session: KineticaSession) {
  return tool(
    "kinetica_resource_groups",
    "List resource groups and their configuration from /show/resourcegroups. Returns {groups, rank_usage, info}. Groups include: name, RAM.max_memory, VRAM.GPU0.max_memory, max_cpu_concurrency, max_data, max_scheduling_priority (100=system, 50=default), max_tier_priority. Value '9223372036854775807' (Long.MAX_VALUE) means unlimited. Default groups are kinetica_system_resource_group (priority 100) and kinetica_default_resource_group (priority 50). rank_usage maps rank IDs to JSON-encoded per-group usage (thread_running_count, data bytes, RAM.used, VRAM.GPU0.used). Only worker ranks appear in rank_usage — rank 0 (head) has no entry. Set show_tier_usage=true for rank-level breakdown.",
    ResourceGroupsSchema.shape,
    async (args: Record<string, unknown>) => {
      const parsed = ResourceGroupsSchema.parse(args);
      const result = await getResourceGroups(session, parsed);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

function makeVerifyDbTool(session: KineticaSession) {
  return tool(
    "kinetica_verify_db",
    "Run a read-only database integrity verification via /admin/verifydb. Checks for null values, persistence issues, and rank0 consistency. Always runs in concurrent_safe mode. Returns {verified_ok: boolean, error_list: [], orphaned_tables_total_size: number}. Healthy: verified_ok=true, empty error_list, orphaned_tables_total_size of -1 (not checked) or 0. WARNING: This is the slowest diagnostic tool — typically takes 500ms-4500ms. Use sparingly and only when data integrity issues are suspected.",
    VerifyDbSchema.shape,
    async (args: Record<string, unknown>) => {
      const parsed = VerifyDbSchema.parse(args);
      const result = await verifyDb(session, parsed);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

function makeShowSecurityTool(session: KineticaSession) {
  return tool(
    "kinetica_show_security",
    "Show security configuration from /show/security. Returns {types, roles, permissions, resource_groups, info}. When enable_authorization=false (check permissions[''].enable_authorization), types/roles/resource_groups are empty objects — the tool provides minimal data. When authorization is enabled: types maps usernames to 'internal_user'/'external_user', roles maps role names to member arrays, permissions maps users to permission arrays, resource_groups maps users to group names. Use to audit access control or diagnose authorization failures.",
    ShowSecuritySchema.shape,
    async (args: Record<string, unknown>) => {
      const parsed = ShowSecuritySchema.parse(args);
      const result = await showSecurity(session, parsed);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

function makeShowTableTool(session: KineticaSession) {
  return tool(
    "kinetica_show_table",
    "Show table metadata from /show/table. When a specific table_name is provided: returns table metadata with Kinetica-native column types, per-column properties (DICT, TEXT_SEARCH, COMPRESS, etc.), and index definitions from ki_catalog.ki_indexes (index_type, index_columns) — this is the preferred method for full table inspection. When table_name is omitted or empty: returns schema-level (collection) entries with sizes, but the processed output may be empty — use kinetica_execute_sql with 'SELECT * FROM ki_catalog.ki_objects WHERE obj_kind = ''R'' ORDER BY schema_name' for reliable table listing instead.",
    ShowTableSchema.shape,
    async (args: Record<string, unknown>) => {
      const parsed = ShowTableSchema.parse(args);
      const result = await showTable(session, parsed);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

function makeResourceObjectsTool(session: KineticaSession) {
  return tool(
    "kinetica_resource_objects",
    "Show per-rank resource tier usage from /show/resource/objects. Returns {rank_objects: {rank_id: JSON_string_with_objects_array}, info}. Each object has: id (naming convention: @table@oid[column][chunk] for data, AttrIndex[...] for indexes, PKIndex_... for PK hashes), size (bytes), priority (1=system, 5=user, 9=temp), tier ('RAM' or 'PERSIST'), evictable (boolean), locked (boolean), pin_count, ram_evictions, persist_evictions, owner_resource_group. The rank_objects JSON is {\"objects\": [...]} — an array nested under an 'objects' key. Only worker ranks have data — rank 0 (head) has no resource objects. Healthy: zero evictions, zero pin_count at rest.",
    ResourceObjectsSchema.shape,
    async (args: Record<string, unknown>) => {
      const parsed = ResourceObjectsSchema.parse(args);
      const result = await getResourceObjects(session, parsed);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

function makeHostManagerStatusTool(session: KineticaSession) {
  return tool(
    "kinetica_host_manager_status",
    "Query the Kinetica host manager root endpoint (port 9300) for cluster-wide status. Returns a flat key-value map including: version, hostname, system_mode ('run'/'stop'), system_status ('running'/'stopped'), system_idle_time (seconds), cluster_leader (IP), cluster_operation ('none'/'rebalance'/etc.), license_type/status/expiration, per-host and per-rank mode/status/pid, and service statuses (ml, httpd, query_planner, reveal, stats, graph, text). Healthy baseline: system_mode='run', system_status='running', all rankN_status='running', license_status='ok'. Does NOT require Kinetica DB authentication — queries the host manager service directly.",
    {},
    async (_args: Record<string, never>) => {
      const result = await hostManagerStatus(session);
      return { content: [{ type: "text" as const, text: applyOutputPipeline(result) }] };
    },
    { annotations: { readOnly: true } },
  );
}

// ---------------------------------------------------------------------------
// Public exports — Phase 3 diagnostic entry point
// ---------------------------------------------------------------------------

/**
 * Returns an array of 16 MCP tool objects for all diagnostic tools.
 * Pass directly to the Claude Agent SDK's agent loop.
 *
 * Usage:
 *   const tools = makeDiagnosticTools(getSession());
 *   // tools passed to Claude agent SDK
 */
export function makeDiagnosticTools(session: KineticaSession, catalogSchemas?: CatalogSchemas) {
  return [
    makeHealthCheckTool(session),
    makeGetMetricsTool(session),
    makeClusterStatusTool(session),
    makeNodeDetailsTool(session),
    makeGetLogsTool(session),
    makeShowConfigurationTool(session),
    makeGetSystemPropertiesTool(session),
    makeExecuteSqlTool(session, catalogSchemas),
    makeExplainQueryTool(session),
    makeSystemTimingTool(session),
    makeResourceGroupsTool(session),
    makeVerifyDbTool(session),
    makeShowSecurityTool(session),
    makeShowTableTool(session),
    makeResourceObjectsTool(session),
    makeHostManagerStatusTool(session),
  ];
}

// ---------------------------------------------------------------------------
// Public exports — Phase 4 mutation entry point
// ---------------------------------------------------------------------------

/**
 * Returns an array of 4 MCP tool objects for mutation tools.
 * These tools are NOT in the diagnostic registry — they default to require
 * user approval via the approval gate (default-deny behavior).
 *
 * Usage:
 *   const mutationTools = makeMutationTools(getSession());
 *   // combined with diagnostic tools in MCP server
 */
export function makeMutationTools(session: KineticaSession) {
  return [
    makeAlterSystemPropertiesTool(session),
    makeExecuteMutationSqlTool(session),
    makeAdminRebalanceTool(session),
    makeAlterConfigurationTool(session),
  ];
}

// ---------------------------------------------------------------------------
// Public exports — ALTER TABLE columns batch tool (self-approving via checklist)
// ---------------------------------------------------------------------------

/**
 * Returns the SdkMcpToolDefinition for kinetica_alter_table_columns.
 *
 * This tool is added to ALLOWED_TOOL_NAMES (bypasses the approval gate)
 * because it implements its own two-step approval: interactive checklist
 * for column selection + SQL preview with y/n confirmation.
 */
export function makeAlterTableColumnsToolWithDeps(session: KineticaSession) {
  return makeAlterTableColumnsTool(session, {
    applyOutputPipeline,
    logMutationAudit,
  });
}
