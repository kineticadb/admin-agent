---
title: Resource Group Exhaustion
category: resources
severity: warning
keywords: [resource, group, limit, exhaustion, tier, capacity]
---

## Symptoms

- Queries failing with resource limit errors
- Tier capacity warnings

## Detection

- `kinetica_resource_groups` → tier usage near limits
- `kinetica_resource_objects` → uneven object distribution across ranks

## Root Cause

Resource group limits too low for workload; uneven data placement across tiers.

## Remediation

1. Increase resource group limits via `kinetica_alter_system_properties`
2. Use `kinetica_admin_rebalance` to redistribute data evenly across ranks
3. Review resource group assignments in `kinetica_show_security`
4. Consider adding new resource groups for workload isolation
