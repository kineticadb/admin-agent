---
title: gpudb.conf Configuration Reference
category: configuration
keywords: [gpudb.conf, config, configuration, parameters, tuning, tiers, alerts]
---

## Overview

`gpudb.conf` is the master Kinetica configuration file (INI format, all under `[gaia]` section).
Default on-disk location: `/opt/gpudb/core/etc/gpudb.conf`.
Retrieved via `kinetica_show_configuration` (host manager port 9300), modified via `kinetica_alter_configuration`.
Runtime properties are a subset available via `kinetica_get_system_properties` / `kinetica_alter_system_properties`.

## Section Index

| Section             | Key Parameters                                                                       | Diagnostic Relevance        |
| ------------------- | ------------------------------------------------------------------------------------ | --------------------------- |
| Identification      | `ring_name`, `cluster_name`                                                          | Cluster identity            |
| Hosts               | `host<#>.address`, `host<#>.ram_limit`, `host<#>.gpus`                               | Host topology, RAM caps     |
| Ranks               | `rank<#>.host`                                                                       | Rank-to-host mapping        |
| Network             | `head_port` (9191), `host_manager_http_port` (9300), `enable_worker_http_servers`    | Connectivity issues         |
| Security            | `require_authentication`, `enable_authorization`                                     | Auth troubleshooting        |
| Auditing            | `enable_audit`, `audit_body`, `lock_audit`                                           | Audit trail                 |
| Licensing           | `license_key`                                                                        | License issues              |
| Processes & Threads | `worker_endpoint_threads`, `tcs_per_tom`, `tps_per_tom`, `subtask_concurrency_limit` | Performance tuning          |
| Hardware            | `rank<#>.taskcalc_gpu`, `rank<#>.numa_node`                                          | GPU/NUMA assignment         |
| General             | `default_ttl`, `chunk_size`, `execution_mode`, `request_timeout`                     | Performance, data lifecycle |
| Visualization       | `max_heatmap_size`, `enable_opengl_renderer`, `enable_vectortile_service`            | WMS/VTS issues              |
| Text Search         | `enable_text_search`, `text_indices_per_tom`                                         | Text search issues          |
| Persistence         | `persist_directory`, `wal.*`, `compression_codec`, `load_vectors_on_start`           | Data durability, startup    |
| Monitoring          | `enable_stats_server`, `telm.persist_query_metrics`                                  | Observability               |
| Graph Servers       | `enable_graph_server`, `graph.server<#>.host`                                        | Graph analytics             |
| HA                  | `enable_ha`, `enable_ha_replay`                                                      | High availability           |
| Alerts              | `alert_memory_percentage`, `alert_disk_percentage`, `heartbeat_*`                    | Alert config                |
| Failover            | `np1.enable_worker_failover`, `np1.rank_restart_attempts`                            | Failover behavior           |
| Postgres Proxy      | `enable_postgres_proxy`, `postgres_proxy.port` (5432)                                | Client connectivity         |
| SQL Engine          | `sql.enable_planner`, `sql.planner.timeout`, `sql.plan_cache_size`                   | Query planning              |
| Tiered Storage      | `tier.{vram,ram,disk,persist,cold}.*`                                                | Memory/storage management   |
| Tier Strategy       | `tier_strategy.default`                                                              | Data placement policy       |
| Resource Groups     | `resource_group.default.*`                                                           | Resource allocation         |

## Performance-Critical Parameters

**Thread Pools** (all accept `-1` for auto):

- `worker_endpoint_threads` — HTTP request handling threads per worker rank
- `tps_per_tom` — data processing threads (inserts, updates, deletes); multi-head ingest not affected
- `tcs_per_tom` — calculation threads (aggregates, record retrieval)
- `subtask_concurrency_limit` — query-level scheduler concurrency; lower = depth-first (fewer queries, faster completion), higher = breadth-first (more concurrency)

**Chunk Settings:**

- `chunk_size` — records per chunk (default 8M; 0 disables chunking)
- `chunk_max_memory` — max total chunk data per table in bytes
- `chunk_column_max_memory` — max per-column chunk data in memory (512MB)

**Execution Mode:** `execution_mode` = `default` | `host` | `device` | `<rows>` — controls CPU vs GPU kernel execution. When set to `device` but no GPUs are available, falls back to CPU.

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
- **7.2.x missing parameters:** `sm_omp_threads`, `kernel_omp_threads` do NOT exist — use `worker_endpoint_threads`, `subtask_concurrency_limit`, `tcs_per_tom` instead
- **Config changes require restart** unless the parameter is also a runtime system property (check via `kinetica_get_system_properties`)
