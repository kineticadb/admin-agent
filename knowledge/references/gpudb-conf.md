---
title: gpudb.conf Configuration Reference
category: configuration
keywords: [gpudb.conf, config, configuration, parameters, tuning, tiers, alerts]
summary: "Master config file: section index, performance-critical parameters, how a change actually takes effect (file edit + restart), tiered-storage limits and watermarks, WAL, alert thresholds, gotchas."
read_when: "Before interpreting any gpudb.conf or `conf.*` property, proposing a config change, or claiming a change took effect."
---

## Overview

`gpudb.conf` is the master Kinetica configuration file (INI format, all under `[gaia]` section).
Default on-disk location: `/opt/gpudb/core/etc/gpudb.conf`.
Retrieved via `kinetica_show_configuration` (host manager port 9300), modified via `kinetica_alter_configuration`.
Runtime properties are a subset available via `kinetica_get_system_properties` / `kinetica_alter_system_properties`.

## Section Index

| Section             | Key Parameters                                                                                                     | Diagnostic Relevance        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| Identification      | `ring_name`, `cluster_name`                                                                                        | Cluster identity            |
| Hosts               | `host<#>.address`, `host<#>.ram_limit`, `host<#>.gpus`                                                             | Host topology, RAM caps     |
| Ranks               | `rank<#>.host`                                                                                                     | Rank-to-host mapping        |
| Network             | `head_port` (9191), `host_manager_http_port` (9300), `enable_worker_http_servers`                                  | Connectivity issues         |
| Security            | `require_authentication`, `enable_authorization`                                                                   | Auth troubleshooting        |
| Auditing            | `enable_audit` (stores at runtime; logger may cache until full restart), `audit_body`, `lock_audit`                | Audit trail                 |
| Licensing           | `license_key`                                                                                                      | License issues              |
| Processes & Threads | `tcs_per_tom`, `tps_per_tom`, `subtask_concurrency_limit` (store at runtime), `worker_endpoint_threads` (rejected) | Performance tuning          |
| Hardware            | `rank<#>.taskcalc_gpu`, `rank<#>.numa_node`                                                                        | GPU/NUMA assignment         |
| General             | `default_ttl`, `chunk_size`, `execution_mode`, `request_timeout`                                                   | Performance, data lifecycle |
| Visualization       | `max_heatmap_size`, `enable_opengl_renderer`, `enable_vectortile_service`                                          | WMS/VTS issues              |
| Text Search         | `enable_text_search`, `text_indices_per_tom`                                                                       | Text search issues          |
| Persistence         | `persist_directory`, `wal.*`, `compression_codec`, `load_vectors_on_start`                                         | Data durability, startup    |
| Monitoring          | `enable_stats_server`, `telm.persist_query_metrics`                                                                | Observability               |
| Graph Servers       | `enable_graph_server`, `graph.server<#>.host`                                                                      | Graph analytics             |
| HA                  | `enable_ha`, `enable_ha_replay`                                                                                    | High availability           |
| Alerts              | `alert_memory_percentage`, `alert_disk_percentage`, `heartbeat_*`                                                  | Alert config                |
| Failover            | `np1.enable_worker_failover`, `np1.rank_restart_attempts`                                                          | Failover behavior           |
| Postgres Proxy      | `enable_postgres_proxy`, `postgres_proxy.port` (5432)                                                              | Client connectivity         |
| SQL Engine          | `sql.enable_planner`, `sql.planner.timeout`, `sql.plan_cache_size`                                                 | Query planning              |
| Tiered Storage      | `tier.{vram,ram,disk,persist,cold}.*`                                                                              | Memory/storage management   |
| Tier Strategy       | `tier_strategy.default`                                                                                            | Data placement policy       |
| Resource Groups     | `resource_group.default.*`                                                                                         | Resource allocation         |

## Performance-Critical Parameters

**Thread Pools** (all accept `-1` for auto):

- `worker_endpoint_threads` — HTTP request handling threads per worker rank _(measured: endpoint rejects it — `gpudb.conf` + restart only)_
- `tps_per_tom` — data processing threads (inserts, updates, deletes); multi-head ingest not affected _(stores at runtime; effect may need a restart)_
- `tcs_per_tom` — calculation threads (aggregates, record retrieval) _(stores at runtime; effect may need a restart)_
- `subtask_concurrency_limit` — query-level scheduler concurrency; lower = depth-first (fewer queries, faster completion), higher = breadth-first (more concurrency) _(stores at runtime; effect may need a restart)_

Three of these store at runtime but their effect on the running system is
unverified; `worker_endpoint_threads` is rejected outright. See Runtime vs File
Configuration below.

**Chunk Settings:**

- `chunk_size` — records per chunk (default 8M; 0 disables chunking)
- `chunk_max_memory` — max total chunk data per table in bytes
- `chunk_column_max_memory` — max per-column chunk data in memory (512MB)

**Execution Mode:** `execution_mode` = `default` | `host` | `device` | `<rows>` — controls CPU vs GPU kernel execution. When set to `device` but no GPUs are available, falls back to CPU.

## How a Configuration Change Works

> Everything in this section was measured directly against a running cluster
> (7.2.3.20, 2 ranks) rather than taken from documentation. Behaviour here could
> differ on another build — if a cluster contradicts this, believe the cluster.

`/alter/system/properties` is **not** an in-memory runtime change. It **edits
`/opt/gpudb/core/etc/gpudb.conf` in place** and mirrors the result to
`persist/gpudb/rank-0/gpudb.conf.bak` (verified: line 412 flipped `4`→`8`, md5
and mtime both changed). `/show/system/properties` then reports **the file**, so
`verification: confirmed` means **persisted, not applied**.

The running process does not re-read it. `tps_per_tom` 4→8 changed **zero threads
on either rank** (rank 0 98/98, rank 1 90/90, identical pool histograms under 32
concurrent queries), and `enable_audit=TRUE` with `audit_headers`/`audit_body`
also TRUE produced no audit artifact anywhere. **Effect comes on restart** — and
because the value is persisted, it survives one. Never report a behaviour change
on `confirmed` alone; report the value as written and say a restart is required.

| `verification` | Meaning                                                                |
| -------------- | ---------------------------------------------------------------------- |
| `confirmed`    | Read back, matches — persisted to `gpudb.conf`. Effect not implied.    |
| `failed`       | Read back unchanged — did not persist.                                 |
| `not_reported` | `/show` does not expose it — 7 of the 43; 4 are still in `gpudb.conf`. |
| `unavailable`  | `/show` unreadable. Unknown.                                           |

**Traps, all measured:**

- **`.bak` is a mirror, not a rollback point** — it holds the NEW value
  immediately. Never offer it as the previous configuration.
- **`kinetica_alter_configuration` writes the SAME file** via the host manager
  (:9300). Using both routes in one investigation risks the second silently
  discarding the first. Pick one.
- **`enable_procs` and `worker_endpoint_threads` are rejected** — the endpoint
  answers `is not a valid parameter`. File edit plus restart only.
- **`/show` also uses DOT notation for sectioned keys.** `/alter` takes
  `ai_api_url`, `/show` returns `conf.ai.api.url`; likewise `kafka.batch_size`,
  `telm.persist_query_metrics`, `postgres_proxy.keep_alive`. **12 of the 43
  allow-listed properties are only reachable this way.** Where the section
  boundary falls is not derivable from the flat name (`postgres_proxy` keeps its
  own underscore), so normalise the RESPONSE key — strip `conf.`, turn dots into
  underscores — rather than guessing dot placements.
- **`/show` is not the whole config surface.** `/show/system/properties` reports
  306 keys; `gpudb.conf` (via `kinetica_show_configuration`, host manager :9300)
  has 330 assignable ones. Neither is a superset — 88 are only in `/show`, 112
  only in the file. So 7 of the 43 return `not_reported`, but for different
  reasons:
  - **4 are in `gpudb.conf` but not `/show`** — `execution_mode`,
    `audit_response`, `egress_single_file_max_size`, and
    `system_metadata_retention_period` (spelled `system_metadata.retention_period`
    in the file, and a **different setting** from the `stats_retention_days` that
    `/show` does report). Since `/alter` writes `gpudb.conf`, the **file is the
    authoritative read-back for these** — use `kinetica_show_configuration` to
    verify them rather than treating `not_reported` as unknowable.
  - **3 appear in neither surface** — `enable_one_step_compound_equi_join`,
    `log_debug_job_info`, `kifs_directory_data_limit`. They are docs-sourced
    names with no evidence they exist on this cluster; the endpoint's own
    `updated_properties_map` echo is the only signal.
- **Acceptance is measured, not assumed:** all 34 testable properties (43 minus
  the 2 blocked and the 7 absent) were accepted by the endpoint, none rejected —
  probed by writing each property's own current value back, so nothing changed.
- **The naming trap:** `/show` returns names `conf.`-prefixed (296 of 306;
  exceptions are `version.*` and `system.font_families`) AND dot-sectioned;
  `/alter` takes them bare and underscore-flattened. A read-back keyed on the
  `/alter` spelling finds nothing and looks like a no-op whether or not the write
  landed — this caught us twice. Be sceptical of any "the property didn't change"
  report that does not say which spelling it read.

## Tiered Storage Quick Reference

Five tier types (data flows down when evicted):

1. **VRAM** — GPU memory; limit/watermarks per rank per GPU
2. **RAM** — main memory; rank0 gets ~10% of system RAM, workers split the rest
3. **Disk** — temporary swap cache (fast SSD recommended); multiple disk tiers supported
4. **Persist** — permanent storage; data survives restarts
5. **Cold** — extended storage (disk, HDFS, S3, Azure, GCS); for infrequently accessed data

**Watermark semantics:** `high_watermark` triggers background eviction; eviction continues until usage drops below `low_watermark`. Both are percentages (1-100). Set both to 100 to disable eviction. Watermarks are ignored when limit is -1.

**Default tier strategy format:** `VRAM <priority>, RAM <priority>, DISK0 <priority>, PERSIST <priority>` — priority 1 (lowest, first evicted) to 9 (highest, last evicted), 10 = unevictable.

## WAL (Write-Ahead Log)

- `wal.sync_policy`: `none` (disabled) | `background` (periodic) | `flush` (per-operation, survives DB crash) | `fsync` (per-operation, survives OS crash)
- `wal.checksum`: integrity protection on WAL entries
- `wal.truncate_corrupt_tables_on_start`: auto-truncate corrupt tables on replay (vs. manual REPAIR TABLE)

## Alert Thresholds

- `alert_memory_percentage` — comma-separated thresholds (e.g., `1, 5, 10, 20`) for low-memory alerts
- `alert_disk_percentage` — same for low-disk alerts
- `heartbeat_interval` / `heartbeat_timeout` / `heartbeat_missed_limit` — host failure detection timing

## Key Gotchas

- **`-1` means different things:** For thread counts = auto-detect; for tier limits = no limit (ignore watermarks); for `default_ttl` = disabled
- **`default_ttl`** is in MINUTES — non-protected tables are auto-deleted after this time. A value of 20 means tables without explicit TTL override vanish after 20 minutes.
- **`load_vectors_on_start = on_demand`** means data loads lazily — first queries on cold data will be slower
- **Rank 0** is the head/coordinator node with minimal RAM allocation (~10%); it does NOT hold data. Worker ranks (1+) hold all data.
- **`execution_mode = device`** silently falls back to CPU when no GPUs are present — no error is raised
- **7.2.x missing parameters:** `sm_omp_threads`, `kernel_omp_threads` do NOT exist. Of the usual substitutes, `worker_endpoint_threads` is rejected by `/alter/system/properties` (measured) — `gpudb.conf` + restart only. `subtask_concurrency_limit` / `tcs_per_tom` / `tps_per_tom` do store at runtime, but their effect may need a restart. See Runtime vs File Configuration above.
- **Config changes require restart** unless the parameter is also a runtime system property (check via `kinetica_get_system_properties`)
