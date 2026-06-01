---
title: Memory Pressure
category: performance
severity: warning
keywords: [memory, pressure, eviction, RAM, slow, disk]
---

## Symptoms

- Slow queries with no obvious cause
- Eviction warnings in logs
- `ki_tiered_objects` showing data moved to PERSIST or DISK tier

## Detection

- `kinetica_get_metrics` → high RAM usage percentage (above 80%)
- `ki_catalog.ki_tiered_objects` → objects in PERSIST/DISK tier that should be in RAM
- `kinetica_resource_objects` → non-zero eviction counts

## Root Cause

Total working set exceeds available RAM; large objects not fitting in configured tier limits.

## Remediation

1. Increase tier memory allocation via `kinetica_alter_system_properties` (conf.tier.\*)
2. Identify and evict cold objects via `kinetica_resource_objects`
3. Archive unused tables to free tier capacity
4. Review resource group memory limits in `kinetica_resource_groups`
