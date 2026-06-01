---
title: Query Contention
category: performance
severity: warning
keywords: [query, contention, slow, blocking, lock, concurrent]
---

## Symptoms

- Long-running queries in `ki_query_history` (large elapsed time between start and completion)
- Active queries blocking each other

## Detection

- `ki_catalog.ki_query_active_all` → multiple long-running queries
- `ki_catalog.ki_query_history` → queries with large elapsed time
- `ki_catalog.ki_query_workers` → blocked worker threads

## Root Cause

Concurrent large queries competing for GPU resources; lock contention on shared tables.

## Remediation

1. Stagger large queries to reduce concurrent GPU pressure
2. Review query priority settings in resource groups
3. Consider query queue configuration via `kinetica_alter_system_properties`
4. Check `kinetica_resource_groups` for CPU concurrency limits
