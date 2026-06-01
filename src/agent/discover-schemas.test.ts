/**
 * Tests for discoverCatalogSchemas — pre-flight schema discovery.
 * TDD RED: these tests must fail until discover-schemas.ts is implemented.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { discoverCatalogSchemas } from "./discover-schemas.js";
import type { KineticaSession } from "../types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockSession(overrides?: Partial<KineticaSession>): KineticaSession {
  return {
    baseUrl: "http://localhost:9191",
    makeRequest: vi.fn(),
    ...overrides,
  };
}

function makeSuccessResponse(rows: unknown[]): Response {
  const innerJson = JSON.stringify(rows);
  // Kinetica double-encodes: data_str is a JSON string inside the outer JSON
  const dataStr = JSON.stringify({
    count_affected: rows.length,
    json_encoded_response: innerJson,
    total_number_of_records: rows.length,
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

function makeErrorResponse(message: string): Response {
  // Kinetica double-encodes: data_str is a JSON string inside the outer JSON
  const dataStr = JSON.stringify({
    count_affected: 0,
    json_encoded_response: "[]",
    total_number_of_records: 0,
    has_more_records: false,
    info: {},
  });
  const outer = {
    status: "ERROR",
    message,
    data_type: "json",
    data_str: dataStr,
  };
  return new Response(JSON.stringify(outer), { status: 200 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discoverCatalogSchemas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a CatalogSchemas with column names grouped by table", async () => {
    const rows = [
      { table_name: "ki_query_history", column_name: "query_id" },
      { table_name: "ki_query_history", column_name: "user_name" },
      { table_name: "ki_query_history", column_name: "query_text" },
      { table_name: "ki_obj_stat", column_name: "object_name" },
      { table_name: "ki_obj_stat", column_name: "total_bytes" },
    ];
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(makeSuccessResponse(rows)),
    });

    const result = await discoverCatalogSchemas(session);

    expect(result).toBeDefined();
    expect(result!.tables.get("ki_query_history")).toEqual(["query_id", "user_name", "query_text"]);
    expect(result!.tables.get("ki_obj_stat")).toEqual(["object_name", "total_bytes"]);
  });

  it("returns undefined when the SQL query returns an error", async () => {
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(makeErrorResponse("Table not found")),
    });

    const result = await discoverCatalogSchemas(session);

    expect(result).toBeUndefined();
  });

  it("returns undefined when makeRequest throws a network error", async () => {
    const session = makeMockSession({
      makeRequest: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });

    const result = await discoverCatalogSchemas(session);

    expect(result).toBeUndefined();
  });

  it("returns undefined when the response has zero rows", async () => {
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(makeSuccessResponse([])),
    });

    const result = await discoverCatalogSchemas(session);

    expect(result).toBeUndefined();
  });

  it("calls makeRequest with a SELECT query against ki_catalog.ki_columns", async () => {
    const session = makeMockSession({
      makeRequest: vi
        .fn()
        .mockResolvedValue(
          makeSuccessResponse([{ table_name: "ki_query_history", column_name: "query_id" }]),
        ),
    });

    await discoverCatalogSchemas(session);

    expect(session.makeRequest).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(session.makeRequest).mock.calls[0];
    expect(callArgs[0]).toBe("/execute/sql");
    const body = callArgs[1] as Record<string, unknown>;
    expect(body.statement).toMatch(/SELECT.*FROM\s+ki_catalog\.ki_columns/i);
    expect(body.statement).toMatch(/ki_query_history/);
    expect(body.statement).toMatch(/ki_tiered_objects/);
  });

  it("includes all 18 target tables in the discovery query", async () => {
    const session = makeMockSession({
      makeRequest: vi
        .fn()
        .mockResolvedValue(
          makeSuccessResponse([{ table_name: "ki_query_history", column_name: "query_id" }]),
        ),
    });

    await discoverCatalogSchemas(session);

    const callArgs = vi.mocked(session.makeRequest).mock.calls[0];
    const body = callArgs[1] as Record<string, unknown>;
    const stmt = body.statement as string;

    const expectedTables = [
      "ki_query_history",
      "ki_query_active_all",
      "ki_query_span_metrics_all",
      "ki_query_workers",
      "ki_tiered_objects",
      "ki_obj_stat",
      "ki_partitions",
      "ki_objects",
      "ki_indexes",
      "ki_periodic_objects",
      "ki_depend",
      "ki_users_and_roles",
      "ki_object_permissions",
      "ki_load_history",
      "ki_backup_history",
      "ki_kafka_lag_info",
      "ki_columns",
      "ki_datatypes",
    ];

    for (const table of expectedTables) {
      expect(stmt).toContain(table);
    }
  });

  it("uses LIMIT 1000 to accommodate all tables", async () => {
    const session = makeMockSession({
      makeRequest: vi
        .fn()
        .mockResolvedValue(
          makeSuccessResponse([{ table_name: "ki_query_history", column_name: "query_id" }]),
        ),
    });

    await discoverCatalogSchemas(session);

    const callArgs = vi.mocked(session.makeRequest).mock.calls[0];
    const body = callArgs[1] as Record<string, unknown>;
    expect(body.limit).toBe(1000);
  });

  it("groups ki_columns rows about itself in the result map", async () => {
    const rows = [
      { table_name: "ki_columns", column_name: "table_name" },
      { table_name: "ki_columns", column_name: "column_name" },
      { table_name: "ki_columns", column_name: "column_type_oid" },
      { table_name: "ki_datatypes", column_name: "oid" },
      { table_name: "ki_datatypes", column_name: "name" },
    ];
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(makeSuccessResponse(rows)),
    });

    const result = await discoverCatalogSchemas(session);

    expect(result).toBeDefined();
    expect(result!.tables.get("ki_columns")).toEqual([
      "table_name",
      "column_name",
      "column_type_oid",
    ]);
    expect(result!.tables.get("ki_datatypes")).toEqual(["oid", "name"]);
  });

  it("does not include tables with no rows in the result map", async () => {
    const rows = [{ table_name: "ki_query_history", column_name: "query_id" }];
    const session = makeMockSession({
      makeRequest: vi.fn().mockResolvedValue(makeSuccessResponse(rows)),
    });

    const result = await discoverCatalogSchemas(session);

    expect(result).toBeDefined();
    expect(result!.tables.has("ki_query_history")).toBe(true);
    expect(result!.tables.has("ki_obj_stat")).toBe(false);
  });
});
