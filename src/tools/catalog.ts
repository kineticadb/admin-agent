import {
  DIAGNOSTIC_TOOL_NAMES,
  MUTATION_TOOL_NAMES,
  ALTER_TABLE_COLUMNS_TOOL_NAME,
} from "./index.js";

type DiagnosticToolName = (typeof DIAGNOSTIC_TOOL_NAMES)[number];
type MutationToolName = (typeof MUTATION_TOOL_NAMES)[number];
export type ToolName = DiagnosticToolName | MutationToolName | typeof ALTER_TABLE_COLUMNS_TOOL_NAME;

export interface ToolCatalogEntry {
  readonly reveals: string;
  readonly whenToUse: string;
}

// Record<ToolName, ...> makes this a compile-time guard: adding a tool to
// DIAGNOSTIC_TOOL_NAMES / MUTATION_TOOL_NAMES without a catalog entry fails typecheck.
export const TOOL_CATALOG: Readonly<Record<ToolName, ToolCatalogEntry>> = {
  kinetica_health_check: {
    reveals: "System health status, version info",
    whenToUse: "Every investigation (Round 1)",
  },
  kinetica_host_manager_status: {
    reveals:
      "Host manager overview: version, license, system mode, per-rank process status/PIDs, service statuses (ML, query planner, reveal, graph, text). No auth required.",
    whenToUse: "Every investigation (Round 1)",
  },
  kinetica_get_metrics: {
    reveals: "CPU, GPU, memory usage per rank",
    whenToUse: "Performance issues, OOM, high load",
  },
  kinetica_cluster_status: {
    reveals: "Rebalance/add/remove ops, shard mapping, alerts, jobs",
    whenToUse: "Cluster instability, replication issues",
  },
  kinetica_node_details: {
    reveals: "Per-node resource statistics",
    whenToUse: "Identifying which node is under pressure",
  },
  kinetica_get_logs: {
    reveals: "Application errors, warnings, system events",
    whenToUse: "Any error investigation (Round 1)",
  },
  kinetica_show_configuration: {
    reveals: "Full gpudb.conf from host manager (port 9300)",
    whenToUse: "Config drift, misconfiguration, complete config inspection",
  },
  kinetica_get_system_properties: {
    reveals: "Runtime config properties (260+ rows); filter by category or key pattern",
    whenToUse: "Read current property values before ALTER, version lookup, feature-flag audit",
  },
  kinetica_execute_sql: {
    reveals: "Query history, active queries, table stats, schema",
    whenToUse: "Slow queries, contention, data issues",
  },
  kinetica_explain_query: {
    reveals: "Query execution plan with operator tree",
    whenToUse: "Query performance optimization",
  },
  kinetica_system_timing: {
    reveals: "Per-endpoint response times, slow API detection",
    whenToUse: "Performance issues, slow endpoint response",
  },
  kinetica_resource_groups: {
    reveals: "Resource group config, tier usage per rank",
    whenToUse: "Resource allocation, tier capacity issues",
  },
  kinetica_verify_db: {
    reveals:
      "Database integrity: nulls, persistence, rank0 (healthy: verified_ok=true, orphaned_size=-1)",
    whenToUse: "Data corruption, integrity verification",
  },
  kinetica_show_security: {
    reveals: "User types, roles, permissions, resource groups",
    whenToUse: "Access control audit, authorization failures",
  },
  kinetica_show_table: {
    reveals: "Table names, sizes, properties, column types",
    whenToUse: "Schema inspection, column type inspection, table size analysis",
  },
  kinetica_resource_objects: {
    reveals: "Per-rank object placement across storage tiers",
    whenToUse: "Tier capacity, eviction, data placement",
  },
  kinetica_alter_system_properties: {
    reveals: "Apply runtime config changes (before/after/verify)",
    whenToUse: "Config drift remediation, thread pool tuning",
  },
  kinetica_execute_mutation_sql: {
    reveals:
      "Execute approved DDL/DML (CREATE INDEX, ALTER TABLE, etc.) — ANALYZE TABLE is NOT supported by Kinetica",
    whenToUse: "Query optimization, index creation",
  },
  kinetica_admin_rebalance: {
    reveals: "Trigger shard rebalancing (requires 2+ worker ranks)",
    whenToUse: "Shard imbalance, uneven data distribution",
  },
  kinetica_alter_configuration: {
    reveals: "Replace gpudb.conf on host manager (before/after/verify)",
    whenToUse: "Config remediation, targeted config file changes",
  },
  kinetica_alter_table_columns: {
    reveals: "Batch column type/property changes (DICT, TEXT_SEARCH, etc.) via checklist",
    whenToUse: "When recommending 2+ column changes on one table",
  },
};

export function buildEvidenceChecklist(): string {
  const ordered: readonly ToolName[] = [
    ...DIAGNOSTIC_TOOL_NAMES,
    ...MUTATION_TOOL_NAMES,
    ALTER_TABLE_COLUMNS_TOOL_NAME,
  ];

  const rows = ordered.map((name) => {
    const entry = TOOL_CATALOG[name];
    return `| ${name} | ${entry.reveals} | ${entry.whenToUse} |`;
  });

  return [
    "| Tool | What it reveals | When to use |",
    "|------|----------------|-------------|",
    ...rows,
  ].join("\n");
}
