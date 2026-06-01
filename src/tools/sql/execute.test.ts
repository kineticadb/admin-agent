/**
 * Tests for isReadOnlySql and executeSql.
 * TDD RED: these tests must fail until execute.ts is implemented.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isReadOnlySql, executeSql, ExecuteSqlSchema } from "./execute.js";
import type { KineticaSession } from "../../types/index.js";

// ---------------------------------------------------------------------------
// isReadOnlySql
// ---------------------------------------------------------------------------

describe("isReadOnlySql", () => {
  it('returns true for "SELECT * FROM t"', () => {
    expect(isReadOnlySql("SELECT * FROM t")).toBe(true);
  });

  it('returns true for "  select * from t" (leading space + lowercase)', () => {
    expect(isReadOnlySql("  select * from t")).toBe(true);
  });

  it('returns true for "WITH cte AS (SELECT 1) SELECT * FROM cte"', () => {
    expect(isReadOnlySql("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe(true);
  });

  it('returns true for "EXPLAIN SELECT * FROM t"', () => {
    expect(isReadOnlySql("EXPLAIN SELECT * FROM t")).toBe(true);
  });

  it('returns false for "INSERT INTO t VALUES (1)"', () => {
    expect(isReadOnlySql("INSERT INTO t VALUES (1)")).toBe(false);
  });

  it('returns false for "DELETE FROM t"', () => {
    expect(isReadOnlySql("DELETE FROM t")).toBe(false);
  });

  it('returns false for "UPDATE t SET x=1"', () => {
    expect(isReadOnlySql("UPDATE t SET x=1")).toBe(false);
  });

  it('returns false for "DROP TABLE t"', () => {
    expect(isReadOnlySql("DROP TABLE t")).toBe(false);
  });

  it('returns false for "" (empty string)', () => {
    expect(isReadOnlySql("")).toBe(false);
  });

  it('returns true for "DESCRIBE ki_catalog.ki_query_history"', () => {
    expect(isReadOnlySql("DESCRIBE ki_catalog.ki_query_history")).toBe(true);
  });

  it('returns true for "DESC ki_catalog.ki_query_history"', () => {
    expect(isReadOnlySql("DESC ki_catalog.ki_query_history")).toBe(true);
  });

  it('returns true for "  describe ki_catalog.ki_obj_stat" (leading space + lowercase)', () => {
    expect(isReadOnlySql("  describe ki_catalog.ki_obj_stat")).toBe(true);
  });

  // --- Comment bypass vectors ---
  it('returns false for "/* comment */ DELETE FROM t" (block comment bypass)', () => {
    expect(isReadOnlySql("/* comment */ DELETE FROM t")).toBe(false);
  });

  it('returns false for "/* */ INSERT INTO t VALUES (1)" (empty block comment)', () => {
    expect(isReadOnlySql("/* */ INSERT INTO t VALUES (1)")).toBe(false);
  });

  it('returns false for "-- comment\nDELETE FROM t" (line comment bypass)', () => {
    expect(isReadOnlySql("-- comment\nDELETE FROM t")).toBe(false);
  });

  it('returns true for "/* comment */ SELECT * FROM t" (block comment before SELECT)', () => {
    expect(isReadOnlySql("/* comment */ SELECT * FROM t")).toBe(true);
  });

  // --- CTE mutation bypass vectors ---
  it('returns false for "WITH cte AS (SELECT 1) DELETE FROM t" (CTE + DELETE)', () => {
    expect(isReadOnlySql("WITH cte AS (SELECT 1) DELETE FROM t")).toBe(false);
  });

  it('returns false for "WITH cte AS (SELECT 1) INSERT INTO t SELECT * FROM cte" (CTE + INSERT)', () => {
    expect(isReadOnlySql("WITH cte AS (SELECT 1) INSERT INTO t SELECT * FROM cte")).toBe(false);
  });

  it('returns false for "WITH cte AS (SELECT 1) UPDATE t SET x = 1" (CTE + UPDATE)', () => {
    expect(isReadOnlySql("WITH cte AS (SELECT 1) UPDATE t SET x = 1")).toBe(false);
  });

  it('returns true for "WITH cte AS (SELECT 1) SELECT * FROM cte" (CTE + SELECT, valid)', () => {
    expect(isReadOnlySql("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe(true);
  });

  it('returns true for nested CTEs: "WITH a AS (SELECT 1), b AS (SELECT * FROM a) SELECT * FROM b"', () => {
    expect(isReadOnlySql("WITH a AS (SELECT 1), b AS (SELECT * FROM a) SELECT * FROM b")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// ExecuteSqlSchema
// ---------------------------------------------------------------------------

describe("ExecuteSqlSchema", () => {
  it("accepts valid statement with defaults", () => {
    const result = ExecuteSqlSchema.parse({ statement: "SELECT 1" });
    expect(result.statement).toBe("SELECT 1");
    expect(result.limit).toBe(100);
  });

  it("accepts explicit limit", () => {
    const result = ExecuteSqlSchema.parse({ statement: "SELECT 1", limit: 500 });
    expect(result.limit).toBe(500);
  });

  it("rejects empty statement", () => {
    expect(() => ExecuteSqlSchema.parse({ statement: "" })).toThrow();
  });

  it("rejects limit above 10000", () => {
    expect(() => ExecuteSqlSchema.parse({ statement: "SELECT 1", limit: 10001 })).toThrow();
  });

  it("rejects limit below 1", () => {
    expect(() => ExecuteSqlSchema.parse({ statement: "SELECT 1", limit: 0 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// executeSql
// ---------------------------------------------------------------------------

function makeMockSession(overrides?: Partial<KineticaSession>): KineticaSession {
  return {
    baseUrl: "http://localhost:9191",
    makeRequest: vi.fn(),
    ...overrides,
  };
}

function makeSuccessResponse(rows: unknown[], totalRecords?: number): Response {
  const innerJson = JSON.stringify(rows);
  // Kinetica double-encodes: data_str is a JSON string inside the outer JSON
  const dataStr = JSON.stringify({
    count_affected: rows.length,
    json_encoded_response: innerJson,
    total_number_of_records: totalRecords ?? rows.length,
    has_more_records: false,
    info: {},
  });
  const outer = {
    status: "OK",
    message: "",
    data_type: "json",
    data_str: dataStr,
  };
  const body = JSON.stringify(outer);
  return new Response(body, { status: 200 });
}

describe("executeSql", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-read-only SQL — returns ok:false, status 400, does NOT call makeRequest", async () => {
    const session = makeMockSession();
    const result = await executeSql(session, "INSERT INTO t VALUES (1)");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/SQL rejected/i);
      expect(result.raw).toBe("INSERT INTO t VALUES (1)");
    }
    expect(session.makeRequest).not.toHaveBeenCalled();
  });

  it("returns ok:true with rows array and rowCount on a successful double-encoded response", async () => {
    const rows = [
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ];
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(makeSuccessResponse(rows, 2)),
    });

    const result = await executeSql(session, "SELECT * FROM t");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(rows);
      expect(result.rowCount).toBe(2);
    }
    expect(session.makeRequest).toHaveBeenCalledWith("/execute/sql", {
      statement: "SELECT * FROM t",
      offset: 0,
      limit: 100,
      encoding: "json",
      options: {},
    });
  });

  it("returns ok:true with rowCount:0 and note for empty result set", async () => {
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(makeSuccessResponse([], 0)),
    });

    const result = await executeSql(session, "SELECT * FROM t WHERE 1=0");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
      expect(result.rowCount).toBe(0);
      expect(result.note).toBe("Query returned 0 rows");
    }
  });

  it("returns ok:false when outer.status is ERROR", async () => {
    const outer = {
      status: "ERROR",
      message: "Table does not exist",
      data_type: "json",
      data_str: JSON.stringify({
        count_affected: 0,
        json_encoded_response: "[]",
        total_number_of_records: 0,
        has_more_records: false,
        info: {},
      }),
    };
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(new Response(JSON.stringify(outer), { status: 200 })),
    });

    const result = await executeSql(session, "SELECT * FROM nonexistent");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("Table does not exist");
    }
  });

  it("returns ok:false with HTTP status on non-200 response", async () => {
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    });

    const result = await executeSql(session, "SELECT 1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/HTTP 401/);
    }
  });

  it("returns ok:false with JSON parse error message on malformed outer JSON", async () => {
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("not-valid-json{{{", { status: 200 })),
    });

    const result = await executeSql(session, "SELECT 1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(200);
      expect(result.error).toMatch(/JSON parse error/i);
    }
  });

  it("uses provided limit parameter when calling makeRequest", async () => {
    const rows = [{ x: 1 }];
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(makeSuccessResponse(rows, 1)),
    });

    await executeSql(session, "SELECT x FROM t", 500);

    expect(session.makeRequest).toHaveBeenCalledWith("/execute/sql", {
      statement: "SELECT x FROM t",
      offset: 0,
      limit: 500,
      encoding: "json",
      options: {},
    });
  });
});
