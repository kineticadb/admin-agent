---
title: GPU Out-of-Memory
category: performance
severity: critical
keywords: [VRAM, GPU, OOM, memory, timeout]
---

## Symptoms

- ERROR logs with "out_of_memory" or GPU OOM, query failures
- `kinetica_get_metrics` shows GPU memory near 100%

## Detection

- `kinetica_get_metrics` → check `vram_used` on worker ranks
- `ki_catalog.ki_tiered_objects` → find large VRAM-tier objects

## Root Cause

Queries materializing too much data in VRAM; oversized objects loaded into GPU memory.

## Remediation

1. Identify largest GPU objects via `kinetica_resource_objects`
2. Add query limits to constrain result set sizes
3. Review GPU memory allocation config via `kinetica_get_system_properties` (conf.tier.\*)
4. Consider tier eviction policy changes
