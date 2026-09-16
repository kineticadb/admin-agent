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
summary: "Pre-execution checklist for rebalance, alter-configuration and DDL, plus the endpoints and properties never to propose."
disclosure: inline
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
- Worker restart — no REST API exists in Kinetica 7.2, and Kinetica has
  no per-rank restart command at all. Read `service-management` with
  `kinetica_knowledge_read` and hand the operator an out-of-band command
  from it — never invent a `gadmin`-style rank command.
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

- **This tool edits `gpudb.conf`.** `/alter/system/properties` writes the value into
  `/opt/gpudb/core/etc/gpudb.conf` in place (and mirrors it to
  `persist/gpudb/rank-0/gpudb.conf.bak`). It is a **persistent config
  edit**, not an in-memory runtime tweak — say so when asking the operator
  to approve one, and note the change survives restarts.
- **`kinetica_alter_configuration` writes the SAME file** via the host
  manager. Do not use both routes in one investigation — the second can
  silently discard the first.
- Allow-list: 43 property names from the 7.2 REST docs; unsupported names
  are rejected before the API call. All 34 testable names were measured
  accepted and none rejected (43 minus 2 blocked and 7 absent from `/show`).
- **`verification` means persisted, not applied.** `confirmed` = read back
  and matches, so the value is in the file. `failed` = did not persist.
  `not_reported` = `/show/system/properties` does not expose this property
  (**7 of the 43**). For 4 of those — `execution_mode`, `audit_response`,
  `egress_single_file_max_size`, `system_metadata_retention_period` — the
  value IS in `gpudb.conf`, so verify with `kinetica_show_configuration`
  instead of giving up. The other 3
  (`enable_one_step_compound_equi_join`, `log_debug_job_info`,
  `kifs_directory_data_limit`) are in neither surface.
  `unavailable` = `/show` unreadable. Report a change as **persisted** only
  on `confirmed`, and never report a behaviour change on it.
- **These four store but do NOT take effect until a restart** —
  `tps_per_tom`, `tcs_per_tom`, `subtask_concurrency_limit`, `enable_audit`.
  Measured: `tps_per_tom` 4→8 changed zero threads on either rank, and
  `enable_audit=TRUE` (with content flags on) produced no audit output. The
  tool attaches a `restart_note`. Tell the operator the value is written and
  a restart is required to realise it — the agent cannot restart services.
- **Rejected outright (measured):** `enable_procs`,
  `worker_endpoint_threads` — `/alter/system/properties` answers "is not a
  valid parameter".
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
- Changes require a database restart to take effect. Read
  `service-management` with `kinetica_knowledge_read` BEFORE writing that
  step and give the operator the exact commands from it — this file does
  not repeat them, deliberately. Never a bare "restart the database", and
  never a `gadmin` command.
- This tool contacts the host manager (port 9300), not the DB engine
  (port 9191).
