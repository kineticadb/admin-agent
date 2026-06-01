---
title: ki_catalog Cross-Table Correlation Paths
category: catalog-schema
keywords:
  [
    ki_catalog,
    joins,
    correlation,
    ki_objects,
    ki_columns,
    ki_partitions,
    ki_query_history,
    ki_tiered_objects,
    oid,
  ]
---

## Overview

When investigating issues, evidence usually has to be joined across
multiple `ki_catalog` tables. These are the standard correlation paths
— prefer them over ad-hoc joins.

## Table Metadata Chain

Walk this chain to go from an object name to its on-disk footprint and
schema:

```
ki_objects.oid
  → ki_obj_stat.oid        (row counts, total sizes)
  → ki_partitions.oid      (tier placement, compression)
  → ki_columns.table_oid   (column schema)
```

## Column Type Resolution

`ki_columns.column_type_oid` is a numeric OID, not a type name. Join
it to `ki_datatypes.oid` to get the human-readable type:

| OID  | Type       |
| ---- | ---------- |
| 20   | `long`     |
| 1043 | `char256`  |
| 1114 | `datetime` |
| 2950 | `uuid`     |
| 25   | `string`   |

## Query Drill-Down

To reconstruct a slow query's execution tree:

```
ki_query_history.query_id
  → ki_query_span_metrics_all.query_id
  → span tree via span_id / parent_span_id
```

## Active Query Workers

For queries currently running:

```
ki_query_active_all.job_id
  → ki_query_workers.job_id   (worker threads, elapsed time, blockers)
```

Use `ki_query_active_all.is_cancellable` to check whether a running
query can be cancelled before suggesting that remediation.

## Permission Audit

```
ki_object_permissions.role_oid   → ki_users_and_roles.oid
ki_object_permissions.object_oid → ki_objects.oid
```

## Dependency Graph

For impact analysis before proposing a DROP:

```
ki_depend.src_obj_oid → ki_objects.oid
ki_depend.dep_obj_oid → ki_objects.oid
```

## Tier Object Lookup (WARNING — no OID join)

`ki_tiered_objects.id` is a **string identifier** (e.g.,
`@nyctaxi@365[col][0]`), NOT a numeric OID. Do NOT try to join it
with `ki_objects.oid` — the types don't match and the values don't
correspond.

For per-table tier placement, prefer the dedicated tool:

```
kinetica_resource_objects  (with table_names filter)
```

For SQL-based analysis, filter with a string match:

```sql
SELECT * FROM ki_catalog.ki_tiered_objects
WHERE id LIKE '%table_name%'
```
