/**
 * Tests for src/tools/index.ts — the diagnostic tool barrel.
 *
 * Verifies:
 * - createDiagnosticRegistry() registers all 16 tool names as read-only
 * - makeDiagnosticTools(session) returns an array of 16 MCP tool objects
 * - makeMutationTools(session) returns an array of 4 MCP tool objects
 */

import { describe, it, expect, vi } from "vitest";
import {
  createDiagnosticRegistry,
  makeDiagnosticTools,
  makeMutationTools,
  MUTATION_TOOL_NAMES,
} from "./index.js";
import type { KineticaSession } from "../types/index.js";

// ---------------------------------------------------------------------------
// Mock session
// ---------------------------------------------------------------------------

const TOOL_NAMES = [
  "kinetica_health_check",
  "kinetica_get_metrics",
  "kinetica_cluster_status",
  "kinetica_node_details",
  "kinetica_get_logs",
  "kinetica_show_configuration",
  "kinetica_get_system_properties",
  "kinetica_execute_sql",
  "kinetica_explain_query",
  "kinetica_system_timing",
  "kinetica_resource_groups",
  "kinetica_verify_db",
  "kinetica_show_security",
  "kinetica_show_table",
  "kinetica_resource_objects",
  "kinetica_host_manager_status",
] as const;

function makeMockSession(): KineticaSession {
  return {
    makeRequest: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi
        .fn()
        .mockResolvedValue(JSON.stringify({ data_str: { status_map: { node0: "running" } } })),
    }),
    baseUrl: "http://localhost:9191",
    username: "admin",
  } as unknown as KineticaSession;
}

// ---------------------------------------------------------------------------
// createDiagnosticRegistry
// ---------------------------------------------------------------------------

describe("createDiagnosticRegistry", () => {
  it("registers exactly 16 tools", () => {
    const registry = createDiagnosticRegistry();
    expect(registry.tools.size).toBe(16);
  });

  it.each(TOOL_NAMES)("registers %s as a read-only tool", (name) => {
    const registry = createDiagnosticRegistry();
    expect(registry.tools.has(name)).toBe(true);
    expect(registry.isReadOnlyTool(name)).toBe(true);
  });

  it("does not register unknown tools as read-only", () => {
    const registry = createDiagnosticRegistry();
    expect(registry.isReadOnlyTool("kinetica_delete_table")).toBe(false);
    expect(registry.isReadOnlyTool("some_unknown_tool")).toBe(false);
  });

  it("returns a new registry — does not mutate the default-deny registry", () => {
    const registryA = createDiagnosticRegistry();
    const registryB = createDiagnosticRegistry();
    // Each call creates a new instance
    expect(registryA).not.toBe(registryB);
    // But both have the same set of tools
    expect(registryA.tools.size).toBe(registryB.tools.size);
  });

  it("mutation tool names are NOT in the diagnostic registry", () => {
    const registry = createDiagnosticRegistry();
    for (const name of MUTATION_TOOL_NAMES) {
      expect(registry.isReadOnlyTool(name)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// makeMutationTools
// ---------------------------------------------------------------------------

describe("makeMutationTools", () => {
  it("returns 4 tool objects", () => {
    const mockSession = {
      makeRequest: vi.fn(),
      baseUrl: "http://localhost:9191",
    } as unknown as KineticaSession;
    const tools = makeMutationTools(mockSession);
    expect(tools).toHaveLength(4);
  });

  it("each mutation tool has the correct .name property", () => {
    const mockSession = {
      makeRequest: vi.fn(),
      baseUrl: "http://localhost:9191",
    } as unknown as KineticaSession;
    const tools = makeMutationTools(mockSession);
    const names = tools.map((t) => t.name);
    expect(names).toContain("kinetica_alter_system_properties");
    expect(names).toContain("kinetica_execute_mutation_sql");
    expect(names).toContain("kinetica_admin_rebalance");
    expect(names).toContain("kinetica_alter_configuration");
  });

  it("each mutation tool has a non-empty description", () => {
    const mockSession = {
      makeRequest: vi.fn(),
      baseUrl: "http://localhost:9191",
    } as unknown as KineticaSession;
    const tools = makeMutationTools(mockSession);
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("each mutation tool has a handler function", () => {
    const mockSession = {
      makeRequest: vi.fn(),
      baseUrl: "http://localhost:9191",
    } as unknown as KineticaSession;
    const tools = makeMutationTools(mockSession);
    for (const t of tools) {
      expect(typeof t.handler).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// makeDiagnosticTools
// ---------------------------------------------------------------------------

describe("makeDiagnosticTools", () => {
  it("returns an array of 16 MCP tool objects", () => {
    const session = makeMockSession();
    const tools = makeDiagnosticTools(session);
    expect(tools).toHaveLength(16);
  });

  it("each tool has the correct .name property", () => {
    const session = makeMockSession();
    const tools = makeDiagnosticTools(session);
    const names = tools.map((t) => t.name);
    for (const expected of TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });

  it("each tool has a non-empty description", () => {
    const session = makeMockSession();
    const tools = makeDiagnosticTools(session);
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("each tool has a handler function", () => {
    const session = makeMockSession();
    const tools = makeDiagnosticTools(session);
    for (const t of tools) {
      expect(typeof t.handler).toBe("function");
    }
  });

  it("each tool has inputSchema (ZodRawShape)", () => {
    const session = makeMockSession();
    const tools = makeDiagnosticTools(session);
    for (const t of tools) {
      expect(t.inputSchema).toBeDefined();
      expect(typeof t.inputSchema).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// Handler invocation tests — verify output pipeline is applied
// ---------------------------------------------------------------------------

/**
 * Build a mock session that returns a specific JSON response body for all calls.
 * This lets us test each tool handler end-to-end without a real Kinetica server.
 */
function makeSessionWithResponse(responseBody: unknown): KineticaSession {
  return {
    makeRequest: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify(responseBody)),
    }),
    baseUrl: "http://localhost:9191",
  };
}

/**
 * Get a specific tool by name from the tools array.
 */
function getTool(tools: ReturnType<typeof makeDiagnosticTools>, name: string) {
  const t = tools.find((tool) => tool.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
}

describe("tool handlers — output pipeline", () => {
  it("kinetica_health_check handler returns text content", async () => {
    const session = makeSessionWithResponse({ data_str: { status_map: { node0: "running" } } });
    const tools = makeDiagnosticTools(session);
    const t = getTool(tools, "kinetica_health_check");
    const result = await t.handler({} as never, undefined);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(typeof (result.content[0] as { type: string; text: string }).text).toBe("string");
  });

  it("kinetica_get_metrics handler returns text content (no node_id)", async () => {
    const session = makeSessionWithResponse({
      data_str: { statistics_map: { node0: { cpu: 0.4 } } },
    });
    const tools = makeDiagnosticTools(session);
    const t = getTool(tools, "kinetica_get_metrics");
    const result = await t.handler({} as never, undefined);
    expect(result.content[0].type).toBe("text");
  });

  it("kinetica_get_metrics handler passes node_id", async () => {
    const session = makeSessionWithResponse({
      data_str: { statistics_map: { node0: { cpu: 0.4 } } },
    });
    const tools = makeDiagnosticTools(session);
    const t = getTool(tools, "kinetica_get_metrics");
    const result = await t.handler({ node_id: "node0" } as never, undefined);
    expect(result.content[0].type).toBe("text");
  });

  it("kinetica_cluster_status handler returns text content", async () => {
    const mockBody = {
      data_str: {
        operation_switch_on: false,
        shard_array: [],
        alert_timestamp_arr: [],
        alert_types_arr: [],
        alert_params_arr: [],
        job_id_arr: [],
        job_status_arr: [],
        job_endpoint_name_arr: [],
      },
    };
    const session = makeSessionWithResponse(mockBody);
    const tools = makeDiagnosticTools(session);
    const t = getTool(tools, "kinetica_cluster_status");
    const result = await t.handler({} as never, undefined);
    expect(result.content[0].type).toBe("text");
  });

  it("kinetica_node_details handler returns text content (no node_id)", async () => {
    const session = makeSessionWithResponse({
      data_str: { statistics_map: { node0: { tier_usage: {} } } },
    });
    const tools = makeDiagnosticTools(session);
    const t = getTool(tools, "kinetica_node_details");
    const result = await t.handler({} as never, undefined);
    expect(result.content[0].type).toBe("text");
  });

  it("kinetica_get_logs handler returns text content", async () => {
    const session = makeSessionWithResponse({ entries: [] });
    const tools = makeDiagnosticTools(session);
    const t = getTool(tools, "kinetica_get_logs");
    const result = await t.handler(
      { source: "kinetica", min_severity: "INFO", limit: 10 } as never,
      undefined,
    );
    expect(result.content[0].type).toBe("text");
  });

  it("kinetica_show_configuration handler returns text content (gpudb.conf from HM)", async () => {
    const configInner = JSON.stringify({
      config_string: "[gpudb]\nenable_audit = false\n",
      info: {},
    });
    const session = {
      // makeRequest fails → discoverHmPort falls back to 9300
      makeRequest: vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue(""),
      }),
      makeRequestToPort: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ data_str: configInner })),
      }),
      baseUrl: "http://localhost:9191",
    } as unknown as KineticaSession;
    const tools = makeDiagnosticTools(session);
    const t = getTool(tools, "kinetica_show_configuration");
    const result = await t.handler({} as never, undefined);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain("enable_audit");
  });

  it("kinetica_get_system_properties handler returns text content", async () => {
    const session = makeSessionWithResponse({
      data_str: { property_map: { "conf.key": "value" } },
    });
    const tools = makeDiagnosticTools(session);
    const t = getTool(tools, "kinetica_get_system_properties");
    const result = await t.handler({} as never, undefined);
    expect(result.content[0].type).toBe("text");
  });

  it("kinetica_execute_sql handler returns text content for valid SELECT", async () => {
    const innerRows = [{ col1: "val1" }];
    const outerBody = {
      status: "OK",
      message: "",
      data_type: "json",
      data_str: {
        count_affected: 1,
        json_encoded_response: JSON.stringify(innerRows),
        total_number_of_records: 1,
        has_more_records: false,
        info: {},
      },
    };
    const session = makeSessionWithResponse(outerBody);
    const tools = makeDiagnosticTools(session);
    const t = getTool(tools, "kinetica_execute_sql");
    const result = await t.handler({ statement: "SELECT 1", limit: 10 } as never, undefined);
    expect(result.content[0].type).toBe("text");
  });

  it("kinetica_execute_sql handler returns failure text for mutation SQL", async () => {
    const session = makeMockSession();
    const tools = makeDiagnosticTools(session);
    const t = getTool(tools, "kinetica_execute_sql");
    const result = await t.handler(
      { statement: "DELETE FROM table1", limit: 10 } as never,
      undefined,
    );
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain("rejected");
  });

  it("kinetica_explain_query handler returns text content", async () => {
    const innerRows = [{ plan_step: "TableScan" }];
    const outerBody = {
      status: "OK",
      message: "",
      data_type: "json",
      data_str: {
        count_affected: 1,
        json_encoded_response: JSON.stringify(innerRows),
        total_number_of_records: 1,
        has_more_records: false,
        info: {},
      },
    };
    const session = makeSessionWithResponse(outerBody);
    const tools = makeDiagnosticTools(session);
    const t = getTool(tools, "kinetica_explain_query");
    const result = await t.handler(
      { statement: "SELECT 1 FROM table1", limit: 10 } as never,
      undefined,
    );
    expect(result.content[0].type).toBe("text");
  });

  it("kinetica_execute_sql handler enriches column error with verified columns", async () => {
    // Simulate a column error response from Kinetica
    const outerBody = {
      status: "ERROR",
      message: "Column 'data_type' was not found in table 'ki_tiered_objects'",
      data_type: "json",
      data_str: {
        count_affected: 0,
        json_encoded_response: "[]",
        total_number_of_records: 0,
        has_more_records: false,
        info: {},
      },
    };
    const session = makeSessionWithResponse(outerBody);
    const schemas = {
      tables: new Map([
        ["ki_tiered_objects", ["object_name", "tier", "rank_id", "owner_resource_group"]],
      ]),
    };
    const tools = makeDiagnosticTools(session, schemas);
    const t = getTool(tools, "kinetica_execute_sql");
    const result = await t.handler(
      { statement: "SELECT data_type FROM ki_catalog.ki_tiered_objects", limit: 10 } as never,
      undefined,
    );
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain("Verified columns for ki_tiered_objects");
    expect(text).toContain("object_name");
  });

  it("kinetica_execute_sql handler passes through non-column errors unchanged", async () => {
    const outerBody = {
      status: "ERROR",
      message: "Table does not exist",
      data_type: "json",
      data_str: {
        count_affected: 0,
        json_encoded_response: "[]",
        total_number_of_records: 0,
        has_more_records: false,
        info: {},
      },
    };
    const session = makeSessionWithResponse(outerBody);
    const schemas = {
      tables: new Map([["ki_tiered_objects", ["object_name", "tier", "rank_id"]]]),
    };
    const tools = makeDiagnosticTools(session, schemas);
    const t = getTool(tools, "kinetica_execute_sql");
    const result = await t.handler(
      { statement: "SELECT * FROM ki_catalog.ki_nonexistent", limit: 10 } as never,
      undefined,
    );
    const text = (result.content[0] as { type: string; text: string }).text;
    // No enrichment because statement references ki_nonexistent which is not in schemas
    expect(text).not.toContain("Verified columns");
  });

  it("makeDiagnosticTools accepts optional catalogSchemas second arg", () => {
    const session = makeMockSession();
    const schemas = { tables: new Map([["ki_obj_stat", ["object_name"]]]) };
    const tools = makeDiagnosticTools(session, schemas);
    expect(tools).toHaveLength(16);
  });

  it("failure result is formatted through the pipeline (not just data)", async () => {
    // Make a session that returns a non-200 response
    const session = {
      makeRequest: vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: vi.fn().mockResolvedValue("Service Unavailable"),
      }),
      baseUrl: "http://localhost:9191",
    } as unknown as KineticaSession;
    const tools = makeDiagnosticTools(session);
    const t = getTool(tools, "kinetica_health_check");
    const result = await t.handler({} as never, undefined);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { type: string; text: string }).text;
    // Should contain error info — ok:false path renders the whole failure object
    expect(text).toContain("false");
  });
});
