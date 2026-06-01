---
title: ki_catalog Enum Values
category: catalog-schema
keywords:
  [
    ki_catalog,
    enums,
    obj_kind,
    shard_kind,
    persistence,
    partition_type,
    tier,
    priority,
    tiered_objects,
  ]
---

## Overview

Many `ki_catalog` columns encode state as single-character codes or
small string constants. These are the canonical values — decode them
explicitly when interpreting query results or building WHERE clauses.

## ki_objects

| Column        | Value | Meaning                       |
| ------------- | ----- | ----------------------------- |
| `obj_kind`    | `R`   | table / relation              |
| `obj_kind`    | `V`   | view                          |
| `shard_kind`  | `S`   | sharded                       |
| `shard_kind`  | `N`   | not sharded                   |
| `persistence` | `P`   | persistent (survives restart) |
| `persistence` | `T`   | temporary                     |

## ki_partitions

| Column           | Value      | Meaning                          |
| ---------------- | ---------- | -------------------------------- |
| `partition_type` | `NONE`     | unpartitioned                    |
| `partition_type` | `INTERVAL` | time-based interval partitioning |

## ki_tiered_objects

### `id` format

String identifier (`char256`), format like `@schema@oid[col][chunk]`
(e.g., `@nyctaxi@365[col][0]`). NOT a numeric OID — **cannot** be
joined to `ki_objects.oid`. See `catalog-joins.md` for the correct
lookup path.

### `tier`

Storage tier placement. One of:

- `RAM` — host memory
- `PERSIST` — persistent SSD/disk tier
- `DISK0` — primary disk tier
- `VRAM` — GPU memory

Same values appear in `ki_partitions.tier`.

### `priority`

Tier manager priority — determines eviction order when a tier fills:

| Value | Meaning                             |
| ----- | ----------------------------------- |
| 1     | system / `ki_catalog` (never evict) |
| 5     | regular user tables                 |
| 9     | temporary / ephemeral               |

Higher `priority` = more expendable = evicted first.

### `locked` and `evictable`

- `locked = 1` — pinned in its current tier; tier manager cannot move it.
- `evictable = 1` — tier manager may move this object to a lower tier
  when space is needed.

An object can be both unlocked and non-evictable (rare; means the tier
manager will not proactively move it but nothing prevents an
administrator from doing so).
