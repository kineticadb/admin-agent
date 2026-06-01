---
title: Kinetica ALTER TABLE — Column Property Syntax
category: sql-syntax
keywords:
  [
    alter-table,
    alter-column,
    modify-column,
    dict,
    text-search,
    compress,
    column-properties,
    shard-key,
    kinetica-alter-table-columns,
  ]
---

## Overview

Kinetica's `ALTER TABLE` syntax for column properties differs from
standard SQL in two non-obvious ways:

1. Column properties live INSIDE the type parentheses, not as trailing
   clauses.
2. There is no `SET`/`ADD`/`DROP` for individual properties — every
   change requires repeating the FULL column definition.

## Single-Column Changes

```sql
-- Add DICT encoding to an existing column (repeat full definition):
ALTER TABLE [schema.]table_name
  ALTER COLUMN column_name VARCHAR(size, DICT) [NOT NULL]

-- Equivalent MODIFY syntax:
ALTER TABLE [schema.]table_name
  MODIFY COLUMN column_name VARCHAR(size, DICT) [NOT NULL]

-- Remove DICT encoding (omit DICT from definition):
ALTER TABLE [schema.]table_name
  ALTER COLUMN column_name VARCHAR(size) [NOT NULL]
```

## Multiple Column Changes

Multiple alterations on the same table can be bundled in a single
statement:

```sql
ALTER TABLE [schema.]table_name
  ALTER COLUMN col1 VARCHAR(50, DICT),
  ALTER COLUMN col2 VARCHAR(100, TEXT_SEARCH) NOT NULL,
  ALTER COLUMN col3 INT(DICT)
```

**For agent use:** when recommending 2+ column changes on one table,
prefer the `kinetica_alter_table_columns` tool — it composes this
bundled statement automatically and surfaces an interactive checklist
for operator approval.

## Key Rules

- **Properties inside parentheses:** `VARCHAR(50, DICT)` —
  NOT `VARCHAR(50) DICT`. Placing the property outside the parens is a
  syntax error.
- **Full definition required:** type, size, properties, nullability
  must all be repeated. There is no `ALTER COLUMN col SET DICT` syntax.
- **Available column properties:** `DICT`, `TEXT_SEARCH`,
  `COMPRESS(type)`, `IPV4`, `NORMALIZE`, `INIT_WITH_NOW`,
  `INIT_WITH_UUID`, `UPDATE_WITH_NOW`.
- **Cascade behavior:** Dependent views, materialized views, and SQL
  procedures are DROPPED when a referenced column is altered. Warn
  operators before proposing ALTER COLUMN on a column with known
  dependencies — check `ki_catalog.ki_depend` first.
- **Shard keys are immutable** — check `is_shard_key` in
  `ki_catalog.ki_columns` (or `properties` in `kinetica_show_table`)
  before proposing ALTER COLUMN. See `version-quirks-7.2.md` for the
  full rule.
