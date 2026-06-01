---
title: ki_tiered_objects Reference
category: storage
keywords: [tiered, tier, storage, RAM, PERSIST, DISK, VRAM, eviction, memory pressure]
---

## Overview

`ki_catalog.ki_tiered_objects` tracks per-chunk tier placement for every data object across all ranks. Each row represents one chunk of data (a column segment, index fragment, etc.) and where it currently lives in the storage hierarchy.

**Two ways to check tier placement:**

- **`kinetica_resource_objects`** (REST tool) — pre-aggregated per-table view via `/show/resource/objects`. Accepts `table_names` filter. Best for checking a specific table's tier distribution.
- **`ki_catalog.ki_tiered_objects`** (SQL) — per-chunk granularity. Best for aggregate analysis across all objects, eviction diagnostics, and memory pressure investigation.

## The `id` Column — NOT a Numeric OID

**CRITICAL:** `id` is a `char256` string identifier, NOT a numeric OID. Do NOT join with `ki_objects.oid`.

Format: `@<table_name>@<internal_id>[<type>][<chunk>]`
Example: `@nyctaxi@365[col][0]`

To filter for a specific table in SQL:

```sql
WHERE id LIKE '%table_name%'
```

For structured per-table tier data, prefer `kinetica_resource_objects` with `table_names` filter instead of SQL joins.

## Column Reference

| Column                 | Type    | Meaning                                          | Diagnostic Use                                 |
| ---------------------- | ------- | ------------------------------------------------ | ---------------------------------------------- |
| `size`                 | long    | Bytes occupied in current tier                   | Identify large objects consuming tier capacity |
| `id`                   | char256 | String object identifier (see above)             | Filter by table name via LIKE                  |
| `priority`             | int     | Eviction priority (1=system, 5=user, 9=temp)     | Higher priority = evicted last                 |
| `tier`                 | char32  | Current storage tier (RAM, PERSIST, DISK0, VRAM) | Identify what's where                          |
| `evictable`            | boolean | Tier manager can evict to lower tier             | Find non-evictable objects blocking space      |
| `locked`               | boolean | Pinned in current tier                           | Locked objects cannot be evicted               |
| `pin_count`            | int     | Active reference count                           | High pin_count = actively used                 |
| `ram_evictions`        | int     | Times evicted from RAM                           | High count = memory pressure thrashing         |
| `persist_evictions`    | int     | Times evicted from PERSIST                       | High count = persist tier pressure             |
| `owner_resource_group` | char128 | Resource group that owns allocation              | Tie back to resource group limits              |
| `source_rank`          | int     | Which rank holds this chunk                      | Per-rank tier analysis                         |
| `outer_object`         | char256 | Parent object name (nullable)                    | Object hierarchy                               |

## Tier Hierarchy

Data flows down when evicted under memory pressure:

```
VRAM (GPU memory) → RAM (main memory) → PERSIST (permanent storage) → DISK0 (swap cache)
```

**Priority values determine eviction order** within a tier:

- **1** — system tables (`ki_catalog.*`), evicted last
- **5** — user tables, standard eviction behavior
- **9** — temporary/ephemeral, evicted first

**Eviction semantics:**

- `evictable=true` — tier manager can move to a lower tier under pressure
- `locked=true` — pinned in current tier, will NOT be evicted regardless of pressure
- When both are false, the object is at rest but not pinned

## Common Diagnostic Queries

```sql
-- Objects NOT in RAM (potential memory pressure — data has been evicted)
SELECT id, tier, size, source_rank, owner_resource_group
FROM ki_catalog.ki_tiered_objects
WHERE tier != 'VRAM' AND tier != 'RAM'
ORDER BY size DESC
LIMIT 20;

-- Per-table tier distribution (replace <table_name>)
SELECT tier, COUNT(*) AS chunks, SUM(size) AS total_bytes
FROM ki_catalog.ki_tiered_objects
WHERE id LIKE '%<table_name>%'
GROUP BY tier;

-- Locked objects preventing eviction
SELECT id, tier, size, source_rank, owner_resource_group
FROM ki_catalog.ki_tiered_objects
WHERE locked = 1
ORDER BY size DESC
LIMIT 20;

-- Objects with high eviction churn (memory pressure indicator)
SELECT id, tier, size, ram_evictions, persist_evictions, source_rank
FROM ki_catalog.ki_tiered_objects
WHERE ram_evictions > 0 OR persist_evictions > 0
ORDER BY ram_evictions + persist_evictions DESC
LIMIT 20;
```

## Key Gotchas

- **Rank 0 has no tiered objects** — it is the head/coordinator node with metadata only. All tiered objects are on worker ranks (1+).
- **VRAM tier only exists when GPUs are present** — on CPU-only clusters, the highest tier is RAM.
- **`outer_object` is nullable** — not all objects have a parent; NULL means top-level object.
- **`source_rank` is dict-encoded** — efficient for filtering/grouping, but values are integers representing rank numbers.
- **Empty results are normal for small datasets** — if all data fits in RAM, there may be no objects on lower tiers.
- **`size` is per-chunk, not per-table** — to get total table size in a tier, SUM(size) with a LIKE filter on the table name.
