/**
 * TDD tests for the ALTER TABLE columns batch tool.
 *
 * Tests define the contract BEFORE implementation (RED phase).
 * Three areas: schema validation, SQL builder, orchestrator flow.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the checklist UI and executeMutationSql
vi.mock("../../approval/checklist.js", () => ({
  showChecklist: vi.fn(),
}));

vi.mock("./execute-mutation-sql.js", () => ({
  executeMutationSql: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => ({
  input: vi.fn(),
}));

import { showChecklist } from "../../approval/checklist.js";
import { executeMutationSql } from "./execute-mutation-sql.js";
import { input } from "@inquirer/prompts";
import type { KineticaSession } from "../../types/index.js";
import {
  AlterTableColumnsSchema,
  buildAlterTableSql,
  alterTableColumns,
} from "./alter-table-columns.js";

const mockShowChecklist = vi.mocked(showChecklist);
const mockExecuteMutationSql = vi.mocked(executeMutationSql);
const mockInput = vi.mocked(input);

function makeSession(): KineticaSession {
  return {
    baseUrl: "http://localhost:9191",
    makeRequest: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("AlterTableColumnsSchema", () => {
  it("accepts valid input with 2 columns", () => {
    const result = AlterTableColumnsSchema.safeParse({
      table_name: "demo.nyctaxi",
      rationale: "Add dictionary encoding to reduce memory",
      columns: [
        {
          column_name: "vendor_id",
          new_definition: "VARCHAR(50, DICT)",
          description: "Add DICT encoding",
        },
        {
          column_name: "payment_type",
          new_definition: "VARCHAR(20, DICT) NOT NULL",
          description: "Add DICT encoding",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty table_name", () => {
    const result = AlterTableColumnsSchema.safeParse({
      table_name: "",
      rationale: "reason",
      columns: [
        { column_name: "c1", new_definition: "INT", description: "d" },
        { column_name: "c2", new_definition: "INT", description: "d" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty rationale", () => {
    const result = AlterTableColumnsSchema.safeParse({
      table_name: "demo.t",
      rationale: "",
      columns: [
        { column_name: "c1", new_definition: "INT", description: "d" },
        { column_name: "c2", new_definition: "INT", description: "d" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects fewer than 2 columns", () => {
    const result = AlterTableColumnsSchema.safeParse({
      table_name: "demo.t",
      rationale: "reason",
      columns: [{ column_name: "c1", new_definition: "INT", description: "d" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects column with empty column_name", () => {
    const result = AlterTableColumnsSchema.safeParse({
      table_name: "demo.t",
      rationale: "reason",
      columns: [
        { column_name: "", new_definition: "INT", description: "d" },
        { column_name: "c2", new_definition: "INT", description: "d" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects column with empty new_definition", () => {
    const result = AlterTableColumnsSchema.safeParse({
      table_name: "demo.t",
      rationale: "reason",
      columns: [
        { column_name: "c1", new_definition: "", description: "d" },
        { column_name: "c2", new_definition: "INT", description: "d" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects column with empty description", () => {
    const result = AlterTableColumnsSchema.safeParse({
      table_name: "demo.t",
      rationale: "reason",
      columns: [
        { column_name: "c1", new_definition: "INT", description: "" },
        { column_name: "c2", new_definition: "INT", description: "d" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts up to 50 columns", () => {
    const columns = Array.from({ length: 50 }, (_, i) => ({
      column_name: `col_${i}`,
      new_definition: "VARCHAR(50, DICT)",
      description: `Change col ${i}`,
    }));
    const result = AlterTableColumnsSchema.safeParse({
      table_name: "demo.t",
      rationale: "reason",
      columns,
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than 50 columns", () => {
    const columns = Array.from({ length: 51 }, (_, i) => ({
      column_name: `col_${i}`,
      new_definition: "VARCHAR(50, DICT)",
      description: `Change col ${i}`,
    }));
    const result = AlterTableColumnsSchema.safeParse({
      table_name: "demo.t",
      rationale: "reason",
      columns,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SQL builder (pure function)
// ---------------------------------------------------------------------------

describe("buildAlterTableSql", () => {
  it("builds single ALTER COLUMN clause", () => {
    const sql = buildAlterTableSql("demo.nyctaxi", [
      { column_name: "vendor_id", new_definition: "VARCHAR(50, DICT)" },
    ]);
    expect(sql).toBe("ALTER TABLE demo.nyctaxi\n  ALTER COLUMN vendor_id VARCHAR(50, DICT)");
  });

  it("builds multiple ALTER COLUMN clauses separated by commas", () => {
    const sql = buildAlterTableSql("demo.nyctaxi", [
      { column_name: "vendor_id", new_definition: "VARCHAR(50, DICT)" },
      { column_name: "payment_type", new_definition: "VARCHAR(20, DICT) NOT NULL" },
    ]);
    expect(sql).toBe(
      "ALTER TABLE demo.nyctaxi\n" +
        "  ALTER COLUMN vendor_id VARCHAR(50, DICT),\n" +
        "  ALTER COLUMN payment_type VARCHAR(20, DICT) NOT NULL",
    );
  });

  it("preserves table name with schema prefix", () => {
    const sql = buildAlterTableSql("my_schema.my_table", [
      { column_name: "c1", new_definition: "INT" },
    ]);
    expect(sql).toContain("ALTER TABLE my_schema.my_table");
  });

  it("preserves complex column definitions including nullability", () => {
    const sql = buildAlterTableSql("demo.t", [
      { column_name: "c1", new_definition: "VARCHAR(100, DICT, TEXT_SEARCH) NOT NULL" },
      { column_name: "c2", new_definition: "TIMESTAMP(INIT_WITH_NOW)" },
    ]);
    expect(sql).toContain("VARCHAR(100, DICT, TEXT_SEARCH) NOT NULL");
    expect(sql).toContain("TIMESTAMP(INIT_WITH_NOW)");
  });
});

// ---------------------------------------------------------------------------
// Orchestrator flow
// ---------------------------------------------------------------------------

describe("alterTableColumns", () => {
  const validInput = {
    table_name: "demo.nyctaxi",
    rationale: "Add DICT encoding for memory reduction",
    columns: [
      { column_name: "vendor_id", new_definition: "VARCHAR(50, DICT)", description: "Add DICT" },
      { column_name: "payment_type", new_definition: "VARCHAR(20, DICT)", description: "Add DICT" },
      {
        column_name: "trip_type",
        new_definition: "VARCHAR(30, TEXT_SEARCH)",
        description: "Add TEXT_SEARCH",
      },
    ],
  };

  beforeEach(() => {
    mockShowChecklist.mockReset();
    mockExecuteMutationSql.mockReset();
    mockInput.mockReset();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  it("returns cancelled result when checklist is cancelled", async () => {
    mockShowChecklist.mockResolvedValueOnce({ action: "cancelled" });

    const result = await alterTableColumns(makeSession(), validInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({ status: "cancelled" });
    }
    expect(mockExecuteMutationSql).not.toHaveBeenCalled();
  });

  it("returns cancelled result when SQL preview is declined", async () => {
    mockShowChecklist.mockResolvedValueOnce({
      action: "confirmed",
      selectedIndices: [0, 1],
    });
    mockInput.mockResolvedValueOnce("n");

    const result = await alterTableColumns(makeSession(), validInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({ status: "declined" });
    }
    expect(mockExecuteMutationSql).not.toHaveBeenCalled();
  });

  it("executes combined SQL when checklist confirmed and SQL approved", async () => {
    mockShowChecklist.mockResolvedValueOnce({
      action: "confirmed",
      selectedIndices: [0, 1],
    });
    mockInput.mockResolvedValueOnce("y");
    mockExecuteMutationSql.mockResolvedValueOnce({
      ok: true,
      data: { rows: [], total_records: 0 },
    });

    const session = makeSession();
    const result = await alterTableColumns(session, validInput);

    expect(result.ok).toBe(true);
    expect(mockExecuteMutationSql).toHaveBeenCalledOnce();
    // Verify the SQL contains both selected columns but not the third
    const sqlArg = mockExecuteMutationSql.mock.calls[0][1];
    expect(sqlArg).toContain("vendor_id VARCHAR(50, DICT)");
    expect(sqlArg).toContain("payment_type VARCHAR(20, DICT)");
    expect(sqlArg).not.toContain("trip_type");
  });

  it("passes only selected columns to the SQL builder", async () => {
    mockShowChecklist.mockResolvedValueOnce({
      action: "confirmed",
      selectedIndices: [2], // Only trip_type
    });
    mockInput.mockResolvedValueOnce("y");
    mockExecuteMutationSql.mockResolvedValueOnce({
      ok: true,
      data: { rows: [], total_records: 0 },
    });

    await alterTableColumns(makeSession(), validInput);

    const sqlArg = mockExecuteMutationSql.mock.calls[0][1];
    expect(sqlArg).toContain("trip_type VARCHAR(30, TEXT_SEARCH)");
    expect(sqlArg).not.toContain("vendor_id");
    expect(sqlArg).not.toContain("payment_type");
  });

  it("returns the executeMutationSql failure result on API error", async () => {
    mockShowChecklist.mockResolvedValueOnce({
      action: "confirmed",
      selectedIndices: [0, 1],
    });
    mockInput.mockResolvedValueOnce("y");
    mockExecuteMutationSql.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: "Syntax error in ALTER TABLE",
      raw: "bad sql",
    });

    const result = await alterTableColumns(makeSession(), validInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Syntax error");
    }
  });

  it("includes the generated SQL in the success result data", async () => {
    mockShowChecklist.mockResolvedValueOnce({
      action: "confirmed",
      selectedIndices: [0],
    });
    mockInput.mockResolvedValueOnce("y");
    mockExecuteMutationSql.mockResolvedValueOnce({
      ok: true,
      data: { rows: [], total_records: 0 },
    });

    const result = await alterTableColumns(makeSession(), validInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("sql");
      expect((result.data as { sql: string }).sql).toContain("ALTER TABLE demo.nyctaxi");
    }
  });

  it("builds checklist items with column labels", async () => {
    mockShowChecklist.mockResolvedValueOnce({ action: "cancelled" });

    await alterTableColumns(makeSession(), validInput);

    expect(mockShowChecklist).toHaveBeenCalledOnce();
    const items = mockShowChecklist.mock.calls[0][2];
    expect(items).toHaveLength(3);
    expect(items[0].label).toContain("vendor_id");
    expect(items[0].label).toContain("VARCHAR(50, DICT)");
    expect(items[0].description).toBe("Add DICT");
  });

  it("treats non-y response as decline (case-insensitive)", async () => {
    mockShowChecklist.mockResolvedValueOnce({
      action: "confirmed",
      selectedIndices: [0],
    });
    mockInput.mockResolvedValueOnce("N");

    const result = await alterTableColumns(makeSession(), validInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({ status: "declined" });
    }
  });

  it("handles y confirmation case-insensitively", async () => {
    mockShowChecklist.mockResolvedValueOnce({
      action: "confirmed",
      selectedIndices: [0],
    });
    mockInput.mockResolvedValueOnce("Y");
    mockExecuteMutationSql.mockResolvedValueOnce({
      ok: true,
      data: { rows: [], total_records: 0 },
    });

    const result = await alterTableColumns(makeSession(), validInput);

    expect(result.ok).toBe(true);
    expect(mockExecuteMutationSql).toHaveBeenCalledOnce();
  });
});
