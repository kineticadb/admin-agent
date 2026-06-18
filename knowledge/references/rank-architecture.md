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

## Where queries are logged — rank 0 only (crash forensics)

The **SQL text and query predicates are logged on rank 0**, the coordinator that receives and plans every query. Worker ranks log only their slice of execution plus any fault. So when a worker rank crashes mid-query, its log holds the **stack trace** but NOT the **triggering SQL** — those are two different ranks.

To recover the triggering SQL for a crashing `JobId`, search **rank 0's** log (the rolling `core-gpudb-rolling-r0.log` or the Loki `rank0.log`) for that JobId. Rank 0 logs, in order:

- `Endpoint.cpp` — `Request URI: /execute/sql … user: …` (who submitted it)
- `Sql/SqlDriver.cpp … Executing SQL: <text>` — the SQL text
- per-operation endpoint lines (`Endpoint_aggregate_group_by.cpp`, filter/join endpoints) — `table:`, `column_names:`/`aliases:` (the SELECT list), and `expr:` (the full WHERE predicate)

**Quirk:** when the line `SqlDriver.cpp … Found plan for the SQL in cache` precedes it, the `Executing SQL:` line is **truncated to just `SELECT`** (a cached plan skips re-logging the text). Reconstruct the query from the per-operation endpoint lines instead — their `table` + `column_names` + `expr` survive regardless of plan cache state. This is the reliable path to a crash's exact query (including timestamp/`datetime()` filters that often trigger parser faults).

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
