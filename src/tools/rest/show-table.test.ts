import { describe, it, expect, vi } from "vitest";
import { ShowTableSchema, showTable } from "./show-table.js";
import type { KineticaSession } from "../../types/index.js";

// show-table.ts does not exist yet — these tests define the expected contract
// They MUST fail on first run (RED phase)

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

/**
 * Creates a session mock that routes responses by endpoint path.
 * Routes is a map of endpoint → response body (or a Response object).
 * Unmatched endpoints return 404.
 */
function makeRoutedSession(routes: Record<string, unknown>): KineticaSession {
  return {
    baseUrl: "http://localhost:9191",
    makeRequest: vi.fn().mockImplementation((endpoint: string) => {
      const body = routes[endpoint];
      if (body === undefined) {
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  };
}

/** Helper to build a mock /execute/sql response for ki_indexes rows. */
function makeSqlIndexResponse(
  rows: ReadonlyArray<{ index_type: string; index_columns: string }>,
): object {
  const jsonEncoded = JSON.stringify({
    column_1: rows.map((r) => r.index_type),
    column_2: rows.map((r) => r.index_columns),
  });
  return {
    status: "OK",
    message: "",
    data_type: "execute_sql_response",
    data_str: JSON.stringify({
      count_affected: rows.length,
      json_encoded_response: jsonEncoded,
      total_number_of_records: rows.length,
      has_more_records: false,
      info: {},
    }),
  };
}

const SAMPLE_RESPONSE = {
  status: "OK",
  data_str: JSON.stringify({
    table_names: ["orders", "customers"],
    table_descriptions: ["Order table", "Customer table"],
    sizes: ["10240", "5120"],
    properties: ["replicated", ""],
  }),
};

// ---- Schema validation ----

describe("ShowTableSchema", () => {
  it("accepts empty object with defaults", () => {
    const result = ShowTableSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.table_name).toBe("");
    }
  });

  it("accepts table_name string", () => {
    const result = ShowTableSchema.safeParse({ table_name: "orders" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.table_name).toBe("orders");
    }
  });

  it("accepts get_sizes boolean", () => {
    const result = ShowTableSchema.safeParse({ get_sizes: true });
    expect(result.success).toBe(true);
  });

  it("accepts get_access_data boolean", () => {
    const result = ShowTableSchema.safeParse({ get_access_data: true });
    expect(result.success).toBe(true);
  });

  it("rejects get_sizes as string", () => {
    const result = ShowTableSchema.safeParse({ get_sizes: "true" });
    expect(result.success).toBe(false);
  });

  it("accepts get_column_info boolean", () => {
    const result = ShowTableSchema.safeParse({ get_column_info: true });
    expect(result.success).toBe(true);
  });

  it("rejects get_column_info as string", () => {
    const result = ShowTableSchema.safeParse({ get_column_info: "true" });
    expect(result.success).toBe(false);
  });
});

// ---- showTable function ----

describe("showTable", () => {
  it("returns ok:true with zipped array on 200 response", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ShowTableSchema.parse({});
    const result = await showTable(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Array<Record<string, string>>;
      expect(data).toHaveLength(2);
      expect(data[0]).toMatchObject({
        table_name: "orders",
        description: "Order table",
        size: "10240",
        properties: "replicated",
      });
      expect(data[1]).toMatchObject({
        table_name: "customers",
        description: "Customer table",
        size: "5120",
        properties: "",
      });
    }
  });

  it("sends get_column_info='false' when table_name is empty (list-all mode)", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ShowTableSchema.parse({});
    await showTable(session, input);

    const callArgs = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = callArgs[1] as { table_name: string; options: Record<string, string> };
    expect(callArgs[0]).toBe("/show/table");
    expect(body.table_name).toBe("");
    expect(body.options.show_children).toBe("false");
    expect(body.options.no_error_if_not_exists).toBe("true");
    expect(body.options.get_column_info).toBe("false");
  });

  it("sends get_column_info='true' when table_name is non-empty", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ShowTableSchema.parse({ table_name: "orders" });
    await showTable(session, input);

    const callArgs = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = callArgs[1] as { options: Record<string, string> };
    expect(body.options.get_column_info).toBe("true");
  });

  it("sends get_column_info='false' when explicitly set to false even with table_name", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ShowTableSchema.parse({ table_name: "orders", get_column_info: false });
    await showTable(session, input);

    const callArgs = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = callArgs[1] as { options: Record<string, string> };
    expect(body.options.get_column_info).toBe("false");
  });

  it("sends get_column_info='true' when explicitly set to true even without table_name", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ShowTableSchema.parse({ get_column_info: true });
    await showTable(session, input);

    const callArgs = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = callArgs[1] as { options: Record<string, string> };
    expect(body.options.get_column_info).toBe("true");
  });

  it("includes get_access_data when set to true", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ShowTableSchema.parse({ get_access_data: true });
    await showTable(session, input);

    const callArgs = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = callArgs[1] as { options: Record<string, string> };
    expect(body.options.get_access_data).toBe("true");
  });

  it("does not include get_access_data when not set", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ShowTableSchema.parse({});
    await showTable(session, input);

    const callArgs = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = callArgs[1] as { options: Record<string, string> };
    expect(body.options).not.toHaveProperty("get_access_data");
  });

  it("returns ok:true with empty array when data arrays are missing", async () => {
    const session = makeSession({ status: "OK", data_str: JSON.stringify({}) });
    const input = ShowTableSchema.parse({});
    const result = await showTable(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
    }
  });

  it("returns ok:false with status on non-200 response", async () => {
    const session = makeSession(null, 404);
    const input = ShowTableSchema.parse({});
    const result = await showTable(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toBe("HTTP 404");
    }
  });

  it("returns ok:false with parse error on invalid JSON", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })),
    };

    const input = ShowTableSchema.parse({});
    const result = await showTable(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(200);
      expect(result.error).toMatch(/JSON parse error/);
    }
  });

  it("returns leaf table metadata with show_children=false", async () => {
    const leafResponse = {
      status: "OK",
      data_str: JSON.stringify({
        table_names: ["demo.nyctaxi"],
        table_descriptions: ["NYC taxi trips"],
        sizes: ["500000"],
        properties: [""],
      }),
    };
    const session = makeSession(leafResponse);
    const input = ShowTableSchema.parse({ table_name: "demo.nyctaxi" });
    const result = await showTable(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { table: Record<string, string>; columns: unknown[] };
      // With table_name set, column info is requested (but no type_schemas in response)
      // So we get the enriched shape with empty columns
      expect(data.table).toMatchObject({
        table_name: "demo.nyctaxi",
        size: "500000",
      });
      expect(data.columns).toEqual([]);
    }
  });

  it("returns ok:false when data_str is malformed JSON string", async () => {
    const session = makeSession({ status: "OK", data_str: "not-valid-json" });
    const input = ShowTableSchema.parse({});
    const result = await showTable(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/data_str parse error/);
    }
  });

  it("never throws — network errors return ok:false", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockRejectedValue(new Error("Connection refused")),
    };

    const input = ShowTableSchema.parse({});
    await expect(showTable(session, input)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Connection refused"),
    });
  });

  // ---- Column info enrichment tests ----

  describe("column info enrichment", () => {
    const TYPE_SCHEMA = JSON.stringify({
      type: "record",
      name: "orders_type",
      fields: [
        { name: "order_id", type: "int" },
        { name: "customer_name", type: ["string", "null"] },
        { name: "amount", type: "double" },
      ],
    });

    const COLUMN_INFO_RESPONSE = {
      status: "OK",
      data_str: JSON.stringify({
        table_names: ["orders"],
        table_descriptions: ["Order table"],
        sizes: ["10240"],
        properties: [
          JSON.stringify({
            order_id: ["data", "int16", "shard_key"],
            customer_name: ["data", "char128", "dict"],
            amount: ["data", "double"],
          }),
        ],
        type_schemas: [TYPE_SCHEMA],
      }),
    };

    it("returns enriched output with columns when type_schemas is present", async () => {
      const session = makeSession(COLUMN_INFO_RESPONSE);
      const input = ShowTableSchema.parse({ table_name: "orders" });
      const result = await showTable(session, input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as {
          table: Record<string, string>;
          columns: Array<{ name: string; type: string; properties: string }>;
        };
        expect(data.table.table_name).toBe("orders");
        expect(data.columns).toHaveLength(3);
        expect(data.columns[0]).toEqual({
          name: "order_id",
          type: "int",
          properties: "data, int16, shard_key",
        });
        expect(data.columns[1]).toEqual({
          name: "customer_name",
          type: "string",
          properties: "data, char128, dict",
        });
        expect(data.columns[2]).toEqual({
          name: "amount",
          type: "double",
          properties: "data, double",
        });
      }
    });

    it("returns table data with empty columns on invalid type_schemas JSON", async () => {
      const badSchemaResponse = {
        status: "OK",
        data_str: JSON.stringify({
          table_names: ["orders"],
          table_descriptions: ["Order table"],
          sizes: ["10240"],
          properties: ["replicated"],
          type_schemas: ["not-valid-json"],
        }),
      };

      const session = makeSession(badSchemaResponse);
      const input = ShowTableSchema.parse({ table_name: "orders" });
      const result = await showTable(session, input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as {
          table: Record<string, string>;
          columns: unknown[];
        };
        expect(data.table.table_name).toBe("orders");
        expect(data.columns).toEqual([]);
      }
    });

    it("handles columns with no matching property entry", async () => {
      const partialPropsResponse = {
        status: "OK",
        data_str: JSON.stringify({
          table_names: ["orders"],
          table_descriptions: ["Order table"],
          sizes: ["10240"],
          properties: [
            JSON.stringify({
              order_id: ["data", "int16"],
              // customer_name deliberately missing
            }),
          ],
          type_schemas: [
            JSON.stringify({
              type: "record",
              name: "orders_type",
              fields: [
                { name: "order_id", type: "int" },
                { name: "customer_name", type: "string" },
              ],
            }),
          ],
        }),
      };

      const session = makeSession(partialPropsResponse);
      const input = ShowTableSchema.parse({ table_name: "orders" });
      const result = await showTable(session, input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as {
          table: Record<string, string>;
          columns: Array<{ name: string; type: string; properties: string }>;
        };
        expect(data.columns[0].properties).toBe("data, int16");
        expect(data.columns[1].properties).toBe("");
      }
    });

    it("returns array of TableEntry when listing all tables (no column info)", async () => {
      const session = makeSession(SAMPLE_RESPONSE);
      const input = ShowTableSchema.parse({});
      const result = await showTable(session, input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // List-all mode returns array of TableEntry, not enriched shape
        const data = result.data as Array<Record<string, string>>;
        expect(Array.isArray(data)).toBe(true);
        expect(data[0]).toHaveProperty("table_name");
        expect(data[0]).not.toHaveProperty("columns");
      }
    });
  });

  // ---- Index fetching tests ----

  describe("index fetching", () => {
    const TYPE_SCHEMA = JSON.stringify({
      type: "record",
      name: "orders_type",
      fields: [
        { name: "order_id", type: "int" },
        { name: "amount", type: "double" },
      ],
    });

    const SHOW_TABLE_RESPONSE = {
      status: "OK",
      data_str: JSON.stringify({
        table_names: ["demo.orders"],
        table_descriptions: ["Order table"],
        sizes: ["10240"],
        properties: [
          JSON.stringify({
            order_id: ["data", "int16", "shard_key"],
            amount: ["data", "double"],
          }),
        ],
        type_schemas: [TYPE_SCHEMA],
      }),
    };

    it("returns indexes alongside columns when SQL returns index data", async () => {
      const session = makeRoutedSession({
        "/show/table": SHOW_TABLE_RESPONSE,
        "/execute/sql": makeSqlIndexResponse([
          { index_type: "column", index_columns: "order_id" },
          { index_type: "column", index_columns: "amount" },
        ]),
      });

      const input = ShowTableSchema.parse({ table_name: "demo.orders" });
      const result = await showTable(session, input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as {
          table: Record<string, string>;
          columns: unknown[];
          indexes: Array<{ index_type: string; index_columns: string }>;
        };
        expect(data.indexes).toHaveLength(2);
        expect(data.indexes[0]).toEqual({
          index_type: "column",
          index_columns: "order_id",
        });
        expect(data.indexes[1]).toEqual({
          index_type: "column",
          index_columns: "amount",
        });
      }
    });

    it("returns empty indexes when SQL query fails", async () => {
      const session = makeRoutedSession({
        "/show/table": SHOW_TABLE_RESPONSE,
        "/execute/sql": { status: "ERROR", message: "Table not found", data_str: "" },
      });

      const input = ShowTableSchema.parse({ table_name: "demo.orders" });
      const result = await showTable(session, input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as {
          table: Record<string, string>;
          columns: unknown[];
          indexes: unknown[];
        };
        expect(data.indexes).toEqual([]);
      }
    });

    it("returns empty indexes when table_name has no schema prefix", async () => {
      const noSchemaResponse = {
        status: "OK",
        data_str: JSON.stringify({
          table_names: ["orders"],
          table_descriptions: ["Order table"],
          sizes: ["10240"],
          properties: [""],
          type_schemas: [TYPE_SCHEMA],
        }),
      };
      const session = makeRoutedSession({
        "/show/table": noSchemaResponse,
        "/execute/sql": makeSqlIndexResponse([{ index_type: "column", index_columns: "order_id" }]),
      });

      const input = ShowTableSchema.parse({ table_name: "orders" });
      const result = await showTable(session, input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as {
          table: Record<string, string>;
          columns: unknown[];
          indexes: unknown[];
        };
        // No schema prefix → cannot construct WHERE clause → empty indexes
        expect(data.indexes).toEqual([]);
      }
    });

    it("sends correct SQL with schema and table filter", async () => {
      const session = makeRoutedSession({
        "/show/table": SHOW_TABLE_RESPONSE,
        "/execute/sql": makeSqlIndexResponse([]),
      });

      const input = ShowTableSchema.parse({ table_name: "demo.orders" });
      await showTable(session, input);

      const calls = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls;
      const sqlCall = calls.find((c: unknown[]) => c[0] === "/execute/sql");
      expect(sqlCall).toBeDefined();
      const sqlBody = sqlCall![1] as { statement: string };
      expect(sqlBody.statement).toContain("ki_catalog.ki_indexes");
      expect(sqlBody.statement).toContain("schema_name = 'demo'");
      expect(sqlBody.statement).toContain("object_name = 'orders'");
    });

    it("escapes single quotes in schema and table names", async () => {
      const trickResponse = {
        status: "OK",
        data_str: JSON.stringify({
          table_names: ["it's.tab'le"],
          table_descriptions: [""],
          sizes: ["0"],
          properties: [""],
          type_schemas: [TYPE_SCHEMA],
        }),
      };
      const session = makeRoutedSession({
        "/show/table": trickResponse,
        "/execute/sql": makeSqlIndexResponse([]),
      });

      const input = ShowTableSchema.parse({ table_name: "it's.tab'le" });
      await showTable(session, input);

      const calls = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls;
      const sqlCall = calls.find((c: unknown[]) => c[0] === "/execute/sql");
      expect(sqlCall).toBeDefined();
      const sqlBody = sqlCall![1] as { statement: string };
      expect(sqlBody.statement).toContain("schema_name = 'it''s'");
      expect(sqlBody.statement).toContain("object_name = 'tab''le'");
    });

    it("does not query indexes in list-all mode", async () => {
      const session = makeRoutedSession({
        "/show/table": SAMPLE_RESPONSE,
      });

      const input = ShowTableSchema.parse({});
      await showTable(session, input);

      const calls = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls;
      const sqlCall = calls.find((c: unknown[]) => c[0] === "/execute/sql");
      expect(sqlCall).toBeUndefined();
    });

    it("returns empty indexes when SQL endpoint returns non-200", async () => {
      const session: KineticaSession = {
        baseUrl: "http://localhost:9191",
        makeRequest: vi.fn().mockImplementation((endpoint: string) => {
          if (endpoint === "/show/table") {
            return Promise.resolve(
              new Response(JSON.stringify(SHOW_TABLE_RESPONSE), { status: 200 }),
            );
          }
          return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
        }),
      };

      const input = ShowTableSchema.parse({ table_name: "demo.orders" });
      const result = await showTable(session, input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as {
          indexes: unknown[];
        };
        expect(data.indexes).toEqual([]);
      }
    });

    it("returns empty indexes when SQL network call throws", async () => {
      let callCount = 0;
      const session: KineticaSession = {
        baseUrl: "http://localhost:9191",
        makeRequest: vi.fn().mockImplementation((endpoint: string) => {
          callCount++;
          if (endpoint === "/show/table") {
            return Promise.resolve(
              new Response(JSON.stringify(SHOW_TABLE_RESPONSE), { status: 200 }),
            );
          }
          return Promise.reject(new Error("ECONNREFUSED"));
        }),
      };

      const input = ShowTableSchema.parse({ table_name: "demo.orders" });
      const result = await showTable(session, input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as { indexes: unknown[] };
        expect(data.indexes).toEqual([]);
      }
      // Verify both /show/table and /execute/sql were called
      expect(callCount).toBe(2);
    });

    it("returns zero-row result as empty indexes array", async () => {
      const emptyResponse = {
        status: "OK",
        message: "",
        data_type: "execute_sql_response",
        data_str: JSON.stringify({
          count_affected: 0,
          json_encoded_response: JSON.stringify({}),
          total_number_of_records: 0,
          has_more_records: false,
          info: {},
        }),
      };
      const session = makeRoutedSession({
        "/show/table": SHOW_TABLE_RESPONSE,
        "/execute/sql": emptyResponse,
      });

      const input = ShowTableSchema.parse({ table_name: "demo.orders" });
      const result = await showTable(session, input);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const data = result.data as { indexes: unknown[] };
        expect(data.indexes).toEqual([]);
      }
    });
  });
});
