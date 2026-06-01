---
title: Kinetica 7.2.x Version Quirks
category: version-compat
keywords:
  [
    7.2,
    version,
    quirks,
    limitations,
    analyze-table,
    verifydb,
    shard-key,
    ki_tables,
    ki_version,
    rebalance,
  ]
---

## Overview

Known limitations and non-obvious behaviors of Kinetica 7.2.x that affect
diagnostic SQL generation, mutation planning, and result interpretation.
If the agent is about to suggest any of the patterns below, these notes
override the "obvious" choice.

## Commands NOT Supported

- **`ANALYZE TABLE`** — returns a syntax error. Kinetica does not maintain
  cost-based optimizer statistics the way PostgreSQL or Oracle do; query
  planning uses shard/column metadata already tracked by the storage
  layer. Do NOT suggest `ANALYZE TABLE` as remediation for query
  performance problems, and do NOT propose it via
  `kinetica_execute_mutation_sql` — there is no equivalent "refresh table
  stats" command to substitute.
- **`ALTER TABLE ... SET SHARD KEY`** on existing columns — shard keys are
  immutable once designated at table creation. To change a shard key, the
  table must be dropped and recreated.

## Missing System Tables in 7.2.x

Querying either of these returns an `"Object not found"` error. Do NOT
attempt them — use the replacement instead:

- `ki_catalog.ki_tables` — does NOT exist. Use
  `ki_catalog.ki_objects WHERE obj_kind = 'R'` to list tables (see
  `knowledge/references/` for the full `obj_kind` enum).
- `ki_catalog.ki_version` — does NOT exist. Get the version from
  `kinetica_health_check` or `kinetica_get_system_properties`
  (`version.*` keys). The version is also surfaced as `version` in the
  session context at startup, so you usually don't need to query at
  all.

## `ki_catalog.ki_columns` — Correct Column Names

The schema uses these names (not the "obvious" SQL-standard names):

| Do NOT use         | Correct 7.2.x name                                                   |
| ------------------ | -------------------------------------------------------------------- |
| `data_type`        | `column_type_oid` (long; join to `ki_datatypes.oid` for type name)   |
| `dict_encoding`    | `is_dict_encoded` (int flag, 0 or 1)                                 |
| `compression_type` | `bytes_on_disk_compressed` / `bytes_on_disk_uncompressed` (two cols) |

## Response Sentinel Values

- **`/admin/verifydb`** returns `orphaned_tables_total_size: -1` on
  healthy systems — `-1` means "check was not run", NOT "something is
  wrong". Do NOT flag `-1` as a problem in diagnostic reports. A real
  orphan count is a non-negative integer.

## Endpoint Preconditions

- **`/admin/rebalance`** requires 2+ worker ranks. Single-worker clusters
  return `"Database must be offline"` — this is expected behavior, not a
  bug, and means rebalance is simply not applicable. Do not suggest
  rebalance on clusters with only rank 0 + one worker.
- **`/show/table`** accepts only two-part names (`<schema>.<table>`).
  Three-part names like `ki_home.ki_catalog.ki_objects` return a 400
  error. Use `ki_catalog.ki_objects` (two parts).
- **`/show/table`** with empty `table_name` returns schema-level
  collections with an empty `sizes` array — NOT a list of tables with
  sizes. For a real table listing with sizes, query
  `ki_catalog.ki_objects` via SQL instead.
- **`/admin/show/logs`** is not implemented on 7.2.x — returns 404
  "Unknown URI". The `kinetica_get_logs` tool falls back to SQL against
  `ki_catalog.ki_log`.

## Default Resource Groups

Every 7.2.x install ships with two groups that should not be flagged as
anomalies:

- `kinetica_system_resource_group` — priority 100 (system reserved)
- `kinetica_default_resource_group` — priority 50 (default user group)

`/show/resourcegroups` includes a `max_tier_priority` field per group.
User-created groups sit between these defaults.
