---
title: Config Drift / Configuration Pitfalls
category: configuration
severity: warning
keywords: [config, drift, configuration, regression, upgrade]
---

## Symptoms

- Unexpected behavior after upgrade or config change
- Performance regression with no workload change

## Detection

- `kinetica_get_system_properties` → compare against known-good values
- `kinetica_get_config` → snapshot shows non-default values (7.2.x: use system properties instead)

## Root Cause

Configuration issue from manual edits, upgrade migration, or environment-specific settings.

## Remediation

1. Use `kinetica_alter_system_properties` to restore known-good config values
2. Review Kinetica changelog for breaking config changes between versions
3. Document baseline configuration for future comparison
