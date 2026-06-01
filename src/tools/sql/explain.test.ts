/**
 * Tests for explainQuery.
 * TDD RED: these tests must fail until explain.ts is implemented.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { explainQuery, ExplainQuerySchema } from "./explain.js";
import type { KineticaSession } from "../../types/index.js";

// ---------------------------------------------------------------------------
// ExplainQuerySchema
// ---------------------------------------------------------------------------

describe("ExplainQuerySchema", () => {
  it("accepts valid statement with defaults", () => {
    const result = ExplainQuerySchema.parse({ statement: "SELECT * FROM t" });
    expect(result.statement).toBe("SELECT * FROM t");
    expect(result.limit).toBe(100);
  });

  it("accepts explicit limit", () => {
    const result = ExplainQuerySchema.parse({ statement: "SELECT 1", limit: 250 });
    expect(result.limit).toBe(250);
  });

  it("rejects empty statement", () => {
    expect(() => ExplainQuerySchema.parse({ statement: "" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// explainQuery
// ---------------------------------------------------------------------------

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
  return new Response(JSON.stringify(outer), { status: 200 });
}

function makeMockSession(overrides?: Partial<KineticaSession>): KineticaSession {
  return {
    baseUrl: "http://localhost:9191",
    makeRequest: vi.fn(),
    ...overrides,
  };
}

describe("explainQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prepends EXPLAIN to the input statement and calls executeSql", async () => {
    const rows = [{ plan: "Scan t" }];
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(makeSuccessResponse(rows, 1)),
    });

    await explainQuery(session, "SELECT * FROM t");

    expect(session.makeRequest).toHaveBeenCalledWith("/execute/sql", {
      statement: "EXPLAIN SELECT * FROM t",
      offset: 0,
      limit: 100,
      encoding: "json",
      options: {},
    });
  });

  it("returns the same ToolResult that executeSql returns", async () => {
    const rows = [{ plan: "Scan t" }];
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(makeSuccessResponse(rows, 1)),
    });

    const result = await explainQuery(session, "SELECT * FROM t");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(rows);
      expect(result.rowCount).toBe(1);
    }
  });

  it("trims leading whitespace from statement before prepending EXPLAIN", async () => {
    const rows = [{ plan: "Index scan" }];
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(makeSuccessResponse(rows, 1)),
    });

    await explainQuery(session, "  SELECT * FROM t");

    expect(session.makeRequest).toHaveBeenCalledWith("/execute/sql", {
      statement: "EXPLAIN SELECT * FROM t",
      offset: 0,
      limit: 100,
      encoding: "json",
      options: {},
    });
  });

  it("uses provided limit parameter", async () => {
    const rows = [{ plan: "Hash join" }];
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(makeSuccessResponse(rows, 1)),
    });

    await explainQuery(session, "SELECT * FROM a JOIN b ON a.id = b.id", 50);

    expect(session.makeRequest).toHaveBeenCalledWith("/execute/sql", {
      statement: "EXPLAIN SELECT * FROM a JOIN b ON a.id = b.id",
      offset: 0,
      limit: 50,
      encoding: "json",
      options: {},
    });
  });

  it("propagates ok:false from executeSql on HTTP failure", async () => {
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("Server Error", { status: 500 })),
    });

    const result = await explainQuery(session, "SELECT 1");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
    }
  });
});
