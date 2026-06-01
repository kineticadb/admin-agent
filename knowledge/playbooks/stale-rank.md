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

1. Tell user to run `gadmin restart rank <N>` manually (no REST API for worker restart in 7.2)
2. After rank recovers, use `kinetica_admin_rebalance` to redistribute shards
3. Verify recovery with `kinetica_health_check` and `kinetica_cluster_status`
