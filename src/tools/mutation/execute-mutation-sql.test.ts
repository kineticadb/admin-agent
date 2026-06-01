/**
 * TDD tests for executeMutationSql and isDeniedMutationSql.
 *
 * Tests define the contract BEFORE implementation (RED phase).
 * isDeniedMutationSql: DDL deny-list with comment-injection protection.
 * executeMutationSql: executes approved SQL via /execute/sql without read-only guard.
 * Never throws -- all error paths return ToolResult with ok:false.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ExecuteMutationSqlSchema,
  executeMutationSql,
  isDeniedMutationSql,
} from "./execute-mutation-sql.js";
import type { KineticaSession } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeSession(body: unknown, statusCode = 200): KineticaSession {
  if (statusCode !== 200) {
    return {
      baseUrl: "http://localhost:9191",
      makeRequest: vi
        .fn()
        .mockResolvedValue(new Response(`HTTP error ${statusCode}`, { status: statusCode })),
    };
  }
  return {
    baseUrl: "http://localhost:9191",
    makeRequest: vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  };
}

// ---------------------------------------------------------------------------
// Sample Kinetica /execute/sql response (double-encoded)
// ---------------------------------------------------------------------------

function makeSqlResponse(rowsJson: unknown, totalRecords = 0) {
  const dataStr = JSON.stringify({
    count_affected: 0,
    json_encoded_response: JSON.stringify(rowsJson),
    total_number_of_records: totalRecords,
    has_more_records: false,
    info: {},
  });
  return {
    status: "OK",
    message: "",
    data_type: "json_encoded_response",
    data_str: dataStr,
  };
}

// ---------------------------------------------------------------------------
// isDeniedMutationSql -- deny-list tests
// ---------------------------------------------------------------------------

describe("isDeniedMutationSql", () => {
  // DROP variants
  it("returns true for DROP TABLE", () => {
    expect(isDeniedMutationSql("DROP TABLE foo")).toBe(true);
  });

  it("returns true for DROP SCHEMA", () => {
    expect(isDeniedMutationSql("DROP SCHEMA public")).toBe(true);
  });

  it("returns true for DROP DATABASE", () => {
    expect(isDeniedMutationSql("DROP DATABASE test")).toBe(true);
  });

  it("returns true for DROP INDEX", () => {
    expect(isDeniedMutationSql("DROP INDEX idx_1")).toBe(true);
  });

  it("returns true for DROP VIEW", () => {
    expect(isDeniedMutationSql("DROP VIEW v1")).toBe(true);
  });

  it("returns true for DROP MATERIALIZED VIEW", () => {
    expect(isDeniedMutationSql("DROP MATERIALIZED VIEW mv1")).toBe(true);
  });

  it("returns true for DROP PROCEDURE", () => {
    expect(isDeniedMutationSql("DROP PROCEDURE p1")).toBe(true);
  });

  it("returns true for DROP FUNCTION", () => {
    expect(isDeniedMutationSql("DROP FUNCTION f1")).toBe(true);
  });

  // TRUNCATE variants
  it("returns true for TRUNCATE TABLE", () => {
    expect(isDeniedMutationSql("TRUNCATE TABLE foo")).toBe(true);
  });

  it("returns true for TRUNCATE without TABLE keyword", () => {
    expect(isDeniedMutationSql("TRUNCATE foo")).toBe(true);
  });

  // DELETE variants
  it("returns true for DELETE FROM", () => {
    expect(isDeniedMutationSql("DELETE FROM foo")).toBe(true);
  });

  it("returns true for bare DELETE without FROM", () => {
    expect(isDeniedMutationSql("DELETE foo")).toBe(true);
  });

  // Comment injection bypass prevention
  it("returns true for block comment before DROP TABLE", () => {
    expect(isDeniedMutationSql("/* comment */ DROP TABLE foo")).toBe(true);
  });

  it("returns true for line comment before DROP TABLE", () => {
    expect(isDeniedMutationSql("-- comment\nDROP TABLE foo")).toBe(true);
  });

  it("returns true for DROP TABLE with leading whitespace (case insensitive)", () => {
    expect(isDeniedMutationSql("  drop table foo")).toBe(true);
  });

  it("returns true for mixed-case DROP TABLE", () => {
    expect(isDeniedMutationSql("Drop Table foo")).toBe(true);
  });

  // Allowed statements
  it("returns false for CREATE INDEX", () => {
    expect(isDeniedMutationSql("CREATE INDEX idx ON t(col)")).toBe(false);
  });

  it("returns false for ALTER TABLE", () => {
    expect(isDeniedMutationSql("ALTER TABLE t SET SHARD KEY (col)")).toBe(false);
  });

  it("returns false for ALTER SYSTEM", () => {
    expect(isDeniedMutationSql("ALTER SYSTEM SET sm_omp_threads = 8")).toBe(false);
  });

  it("returns false for ANALYZE TABLE", () => {
    expect(isDeniedMutationSql("ANALYZE TABLE t")).toBe(false);
  });

  it("returns false for REFRESH MATERIALIZED VIEW", () => {
    expect(isDeniedMutationSql("REFRESH MATERIALIZED VIEW mv1")).toBe(false);
  });

  it("returns false for CREATE MATERIALIZED VIEW", () => {
    expect(isDeniedMutationSql("CREATE MATERIALIZED VIEW mv1 AS SELECT 1")).toBe(false);
  });

  it("returns false for SELECT (reads allowed -- they just won't be useful)", () => {
    expect(isDeniedMutationSql("SELECT * FROM foo")).toBe(false);
  });

  // CTE-wrapped DML bypass prevention (H-1)
  it("returns true for WITH ... DELETE FROM (CTE-wrapped DELETE)", () => {
    expect(isDeniedMutationSql("WITH t AS (SELECT 1) DELETE FROM target")).toBe(true);
  });

  it("returns true for WITH ... DROP TABLE (CTE-wrapped DROP)", () => {
    expect(isDeniedMutationSql("WITH t AS (SELECT 1) DROP TABLE target")).toBe(true);
  });

  it("returns true for WITH ... UPDATE (CTE-wrapped UPDATE)", () => {
    expect(isDeniedMutationSql("WITH t AS (SELECT 1) UPDATE target SET c = 1")).toBe(true);
  });

  it("returns true for multi-statement with trailing DROP", () => {
    expect(isDeniedMutationSql("ALTER TABLE t ADD COLUMN c INT; DROP TABLE u")).toBe(true);
  });

  // UPDATE handling
  it("returns true for UPDATE at start of statement", () => {
    expect(isDeniedMutationSql("UPDATE t SET c = 1")).toBe(true);
  });

  it("returns true for mixed-case update", () => {
    expect(isDeniedMutationSql("Update t SET c = 1")).toBe(true);
  });

  it("returns false for SELECT ... FOR UPDATE (lock hint, not a mutation)", () => {
    expect(isDeniedMutationSql("SELECT * FROM t WHERE id = 1 FOR UPDATE")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ExecuteMutationSqlSchema -- schema validation
// ---------------------------------------------------------------------------

describe("ExecuteMutationSqlSchema", () => {
  it("accepts valid statement", () => {
    const result = ExecuteMutationSqlSchema.safeParse({
      statement: "CREATE INDEX idx ON t(col)",
    });
    expect(result.success).toBe(true);
  });

  it("applies default limit of 100 when not specified", () => {
    const result = ExecuteMutationSqlSchema.safeParse({
      statement: "CREATE INDEX idx ON t(col)",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(100);
    }
  });

  it("accepts custom limit", () => {
    const result = ExecuteMutationSqlSchema.safeParse({
      statement: "CREATE INDEX idx ON t(col)",
      limit: 500,
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty statement", () => {
    const result = ExecuteMutationSqlSchema.safeParse({ statement: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing statement", () => {
    const result = ExecuteMutationSqlSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeMutationSql -- function tests
// ---------------------------------------------------------------------------

describe("executeMutationSql", () => {
  it("returns ok:false with 'SQL rejected' error when deny-list matches -- no network call", async () => {
    const session = makeSession(null);
    const result = await executeMutationSql(session, "DROP TABLE foo", 100);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/SQL rejected/);
    }
    // No network call should have been made
    expect(session.makeRequest).not.toHaveBeenCalled();
  });

  it("calls /execute/sql with statement and encoding:json for allowed SQL", async () => {
    const session = makeSession(makeSqlResponse([], 0));
    const statement = "CREATE INDEX idx ON t(col)";
    await executeMutationSql(session, statement, 100);

    expect(session.makeRequest).toHaveBeenCalledWith(
      "/execute/sql",
      expect.objectContaining({
        statement,
        encoding: "json",
      }),
    );
  });

  it("returns ok:true with execution result for successful mutation", async () => {
    const session = makeSession(makeSqlResponse([], 0));
    const result = await executeMutationSql(session, "CREATE INDEX idx ON t(col)", 100);

    expect(result.ok).toBe(true);
  });

  it("returns ok:false on non-200 HTTP response", async () => {
    const session = makeSession(null, 503);
    const result = await executeMutationSql(session, "CREATE INDEX idx ON t(col)", 100);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
    }
  });

  it("returns ok:false with parse error on invalid JSON response", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })),
    };

    const result = await executeMutationSql(session, "CREATE INDEX idx ON t(col)", 100);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/JSON parse error/);
    }
  });

  it("returns ok:false when outer status is ERROR", async () => {
    const session = makeSession({
      status: "ERROR",
      message: "Permission denied",
      data_type: "none",
      data_str: "",
    });

    const result = await executeMutationSql(session, "ALTER TABLE t ADD COLUMN c INT", 100);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Permission denied/);
    }
  });

  it("never throws -- network error returns ok:false", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockRejectedValue(new Error("Connection refused")),
    };

    await expect(
      executeMutationSql(session, "CREATE INDEX idx ON t(col)", 100),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Connection refused"),
    });
  });

  it("does NOT call isReadOnlySql -- allows DDL that read-only tool would reject", async () => {
    // ALTER TABLE would be rejected by isReadOnlySql (not a SELECT/WITH/EXPLAIN)
    // but executeMutationSql should allow it
    const session = makeSession(makeSqlResponse([], 0));
    const result = await executeMutationSql(session, "ALTER TABLE t SET SHARD KEY (col)", 100);

    expect(result.ok).toBe(true);
    expect(session.makeRequest).toHaveBeenCalled();
  });
});
