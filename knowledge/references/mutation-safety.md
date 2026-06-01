---
title: Mutation Safety Rules
category: mutation-policy
keywords:
  [
    mutation,
    safety,
    admin-rebalance,
    alter-system-properties,
    alter-configuration,
    never-propose,
    ai_api_key,
    cache-clearing,
    worker-restart,
    aggressiveness,
  ]
---

## Overview

Safety contract the agent must follow before and during Round 4
(Mutation Proposal) of the investigation protocol. These rules combine
version-specific Kinetica 7.2.x facts with operational policy — every
mutation tool call is subject to them.

## Pre-Mutation Checklist

BEFORE proposing any mutation:

1. Always run `kinetica_health_check` first — do not mutate an unhealthy
   cluster.
2. For `kinetica_admin_rebalance`: check `kinetica_cluster_status` for
   active rebalance/add/remove operations — never propose rebalance
   when one is already running.
3. For config changes: use `kinetica_get_system_properties` to read the
   current value BEFORE proposing a change (so the report can show a
   meaningful before/after diff).

## NEVER Propose

- `/clear/table` or `/clear/tablemonitor` as cache-clearing operations —
  these DELETE DATA permanently in Kinetica. They are not caches.
- Setting `ai_api_key` via `kinetica_alter_system_properties` — this is
  a credential that would appear in audit logs.
- Setting `external_files_directory` — filesystem path; potential path
  traversal concern.
- Setting `flush_to_disk` — can trigger an expensive I/O storm.
- Worker restart — no REST API exists in Kinetica 7.2. Tell the
  operator to run `gadmin restart rank <N>` manually instead.
- Cache clearing — no safe API exists in Kinetica 7.2. Recommend
  query-side solutions (rewriting the query, adding an index, bumping
  resource group limits) instead of trying to clear caches.

## For `kinetica_admin_rebalance`

- Recommend aggressiveness 1–3 during production hours (reduces query
  latency impact).
- Recommend aggressiveness 4–5 during maintenance windows only.
- Warn the operator: rebalance causes "delayed query responses" while
  running.
- Check `kinetica_cluster_status` for active jobs before proposing.
- On single-worker-rank clusters (rank 0 + 1 worker), rebalance
  returns "Database must be offline" — rebalance is only meaningful
  with 2+ worker ranks.

## For `kinetica_alter_system_properties`

- The tool enforces an allow-list of 43 documented properties —
  unsupported names are rejected before the API call.
- Prefer changing `subtask_concurrency_limit`, `tcs_per_tom`, or
  `tps_per_tom` for concurrency tuning.
- NOTE: `sm_omp_threads` and `kernel_omp_threads` do NOT exist in
  Kinetica 7.2.x (not in the allow-list).
- Avoid `chunk_size` changes without DBA review — affects all query
  performance.
- `request_timeout` changes affect ALL endpoints system-wide.

## For `kinetica_alter_configuration`

- ALWAYS read the current config via `kinetica_show_configuration`
  first.
- Make targeted edits to specific lines — never compose a config from
  scratch.
- Submit the full modified `config_string` (the entire file is
  replaced).
- Changes require a service restart to take effect — inform the
  operator.
- This tool contacts the host manager (port 9300), not the DB engine
  (port 9191).
