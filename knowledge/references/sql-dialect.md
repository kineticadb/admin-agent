---
title: Kinetica SQL Dialect — PostgreSQL Baseline & False Friends
category: sql-syntax
keywords:
  [
    sql-dialect,
    postgresql,
    false-friends,
    try-cast,
    safe-cast,
    cast,
    convert,
    remediation-sql,
    datediff,
    timestamp,
    nested-aggregate,
    identifiers,
    backticks,
    decimal,
    numeric,
  ]
---

## Mental Model — Start from PostgreSQL

Kinetica SQL is **PostgreSQL-compatible**: treat standard PostgreSQL syntax,
functions, and behavior as the baseline. The deviations documented here (and in
`version-quirks-7.2.md`) **override** that baseline. When no Kinetica-specific
rule applies, the PostgreSQL form is the safe default.

**The common failure when recommending remediation SQL is importing idioms from
OTHER dialects** — SQL Server, Snowflake, Oracle, MySQL. Those are not the
baseline; PostgreSQL is. The table below lists imports that look valid but fail
in Kinetica.

> Dialect facts adapted from the official `kineticadb/agent-skills` knowledge
> base (Apache-2.0).

## False Friends — Looks Valid, FAILS in Kinetica

Do NOT put any of these in a remediation suggestion. Use the Kinetica form.

| Looks valid (other dialect)            | Why it fails                                                | Use instead                                                                     |
| -------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `TRY_CAST(x AS t)` / `SAFE_CAST(x, t)` | No error-tolerant cast exists in Kinetica                   | `CAST(x AS t)` or `CONVERT(x, t)`; shorthand `INT(x)`, `DOUBLE(x)`, `STRING(x)` |
| `` `ident` `` (backtick quoting)       | Backticks are not a valid identifier quote                  | ANSI double quotes: `"ident"`                                                   |
| `ts1 - ts2` (timestamp subtraction)    | Timestamp arithmetic with `-` is not supported              | `DATEDIFF('unit', ts1, ts2)`                                                    |
| `NUMERIC(p, s)`                        | The type is named `DECIMAL`, not `NUMERIC`                  | `DECIMAL(p, s)` (max precision 27, max scale 18)                                |
| `SUM(COUNT(*))` (nested aggregates)    | Fails with "Aggregate expressions cannot be nested"         | Separate into CTEs — window/aggregate in different stages                       |
| `ANALYZE TABLE t`                      | No cost-based optimizer stats (see `version-quirks-7.2.md`) | No equivalent — do NOT suggest a "refresh table stats" step                     |
| `SELECT ... ;` (trailing semicolon)    | A trailing `;` is rejected                                  | Omit the trailing semicolon                                                     |
| `ORDER BY <array_col>`                 | Cannot sort by an `array<...>` column                       | Index an element (`ORDER BY "col"[1]`) or sort by a scalar column               |

`TRY_CAST` / `SAFE_CAST` warrant special note: they come from SQL Server,
Snowflake, and BigQuery, and Kinetica has no cast variant that returns NULL on
conversion failure. If a value might not convert cleanly, filter the source rows
(`WHERE` / `CASE`) before casting rather than reaching for a non-existent
`TRY_*` function.

## Type Conversion — the Valid Forms

- Standard `CAST(expr AS type)` and `CONVERT(expr, type)` both work.
- Shorthand cast functions: `INT(expr)`, `LONG(expr)`, `DOUBLE(expr)`,
  `FLOAT(expr)`, `DECIMAL(expr)`, `STRING(expr)`, `ULONG(expr)`.
- `JSON_EXTRACT_VALUE` always returns TEXT — you MUST cast for numeric use:
  `CAST(JSON_EXTRACT_VALUE("payload", '$.count') AS INTEGER) > 100`.

## Date / Time — Use Functions, Not Arithmetic

| Kinetica form                        | Replaces (PostgreSQL / other)     |
| ------------------------------------ | --------------------------------- |
| `DATEDIFF('unit', start, end)`       | `EXTRACT(EPOCH FROM end - start)` |
| `DATEADD('unit', amount, ts)`        | `ts + INTERVAL '...'`             |
| `TIME_BUCKET(INTERVAL 'n' UNIT, ts)` | `date_bin()`                      |

Units: `SECOND, MINUTE, HOUR, DAY, WEEK, MONTH, QUARTER, YEAR` (also
`MICROSECOND` / `MILLISECOND`). INTERVAL syntax: `INTERVAL '30' MINUTE`.

## Identifier & Statement Hygiene

- **Double quotes only** for identifiers (`"my_col"`) — never backticks.
- **Identifiers are case-sensitive** — `"UserID"` ≠ `"userid"`. Verify column
  names against the discovered schema before recommending SQL.
- **Fully-qualify table names** — `"schema"."table"`.
- **No trailing semicolons.**

## Kinetica Conveniences (valid, non-obvious)

- `SELECT * EXCLUDE (col1, col2)` — wildcard minus specific columns.
- `IF(cond, a, b)` — ternary (PostgreSQL has only `CASE`).
- `NVL(x, default)` / `NVL2(x, not_null, null_val)` — null handling.
- `DECODE(expr, m1, v1, ..., default)` — pattern matching.

## When Unsure — Verify Empirically

The live database is the source of truth. Before recommending any remediation
SQL whose syntax you are not certain Kinetica supports, validate it with
`kinetica_explain_query` against the live instance. If it cannot be validated
(or there is no live connection), label the suggestion as unverified rather than
asserting it is correct.
