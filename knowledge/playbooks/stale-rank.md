---
title: Stale Rank (Rank Not Responding)
category: cluster
severity: critical
keywords: [rank, stale, offline, crash, partition]
---

## Symptoms

- Health check shows unhealthy rank
- Cluster status shows rank offline

## Detection

- `kinetica_health_check` → non-OK rank status
- `kinetica_cluster_status` → rank alerts, shard mapping gaps

## Root Cause

Stale rank process after crash or network partition; rank failed to rejoin cluster.

## Remediation

There is **no per-rank restart command** in Kinetica — see `service-management.md`.
Ranks are supervised by the Host Manager, and service control is host-level.

1. Identify the **host** the stale rank runs on via `kinetica_host_manager_status`
   (or `kinetica_cluster_status`), and check whether the Host Manager has already
   attempted recovery (`np1.rank_restart_attempts`).
2. If a restart is still needed, tell the operator to restart the database on that
   host, as root: `systemctl stop gpudb` then `systemctl start gpudb`. State that
   this affects the whole database on that host, not just the one rank.
3. After the rank rejoins, use `kinetica_admin_rebalance` to redistribute shards
4. Verify recovery with `kinetica_health_check` and `kinetica_cluster_status`
