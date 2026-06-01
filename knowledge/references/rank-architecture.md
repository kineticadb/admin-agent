---
title: Kinetica Rank Architecture
category: cluster-topology
keywords: [ranks, rank-0, head, coordinator, worker, shards, metrics-interpretation, asymmetry]
---

## Overview

Kinetica uses a rank-based distributed architecture. A single host
typically runs one head rank (rank 0) plus one or more worker ranks
(rank 1, rank 2, …). Understanding the asymmetry between rank 0 and
worker ranks is essential to correctly interpreting metrics and
resource-group reports.

## Rank 0 — Head / Coordinator

- Stores only **metadata** (~4 MB RAM steady-state).
- Has **no** `PERSIST` / `DISK` / `VRAM` tiers configured — data
  tiers live on worker ranks.
- Has **no** resource objects (nothing to place in tiers).
- Has **no** `rank_usage` entry in resource groups.
- Much lower RAM limit, typically ~750 MB.
- Responsible for coordinating queries, query planning, and routing
  requests to worker ranks.

## Rank 1+ — Workers / Data Nodes

- Hold the actual user data.
- Have full tier configuration (RAM / PERSIST / DISK / VRAM as
  configured in `gpudb.conf`).
- All 16,384 shards map to worker ranks (rank 0 holds no shards).
- RAM limits typically 5+ GB per rank.

## Interpreting Metrics — Key Rule

**Rank 0's low resource usage is normal — it is NOT a sign of
imbalance or a failing node.**

When reviewing `kinetica_get_metrics` or `kinetica_node_details`:

- Compare worker ranks against each other — rank 1 vs rank 2 vs …
- Do NOT compare rank 0 against worker ranks; the asymmetry will
  always make rank 0 look "idle".
- Do NOT propose rebalance because rank 0 has less data than workers
  — that is the expected topology.

Similarly, when a resource group report shows no `rank_usage` for
rank 0, that is correct — nothing runs in resource groups on the head
rank.

## Single-Worker Clusters

Rebalance requires 2+ worker ranks — see `version-quirks-7.2.md` for
the exact `/admin/rebalance` precondition and error message.
