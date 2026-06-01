---
title: Kinetica CREATE INDEX / DROP INDEX Syntax
category: sql-syntax
keywords: [create-index, drop-index, index, ki_indexes, if-not-exists, explain, query-optimization]
---

## Overview

Kinetica's `CREATE INDEX` syntax differs from standard SQL in two
places worth flagging up front:

1. The index name is **required** and goes **before** `ON` — there is
   no "unnamed index" form.
2. Kinetica does NOT support `IF NOT EXISTS` — you must check
   `ki_catalog.ki_indexes` before creating an index to avoid a
   duplicate-name error.

## Syntax

```sql
-- Single column:
CREATE INDEX index_name ON [schema.]table_name (column_name)

-- Multiple columns (composite index):
CREATE INDEX index_name ON [schema.]table_name (col1, col2)

-- Drop an index:
DROP INDEX index_name ON [schema.]table_name
```

## Key Rules

- **Index name is REQUIRED and goes BEFORE `ON`:**
  - Correct: `CREATE INDEX idx_user_email ON users (email)`
  - WRONG: `CREATE INDEX ON users (email)` — syntax error
- **No `IF NOT EXISTS`:** Kinetica rejects this clause. Before
  creating an index, query `ki_catalog.ki_indexes` to see whether
  an index already covers the column(s). Skipping this check and
  retrying on failure is wasted work and pollutes audit logs.
- **Verify with `kinetica_explain_query`:** run
  `kinetica_explain_query` on the target query both BEFORE and AFTER
  index creation. The plan should show the new index being used;
  if it isn't, either the query doesn't benefit from the index or
  the statistics haven't caught up — there is no
  `ANALYZE TABLE` to force stats refresh (see
  `version-quirks-7.2.md`).
- **Naming convention:** prefer `idx_<table>_<column>` or
  `idx_<table>_<cols>_<purpose>` so index names stay discoverable in
  `ki_catalog.ki_indexes`.
