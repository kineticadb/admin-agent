/**
 * Batch ALTER TABLE column changes with interactive checklist.
 *
 * Combines multiple column type/property changes into a single ALTER TABLE
 * statement for efficiency. The operator selects which columns to alter via
 * an interactive checkbox, then confirms the generated SQL before execution.
 *
 * Two-step approval (implemented in handler, not the SDK approval gate):
 *   1. Checklist — select which columns to alter
 *   2. SQL preview — confirm the exact ALTER TABLE statement
 *
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or input objects.
 *
 * Exports:
 *   AlterTableColumnsSchema  — Zod schema for tool input validation
 *   buildAlterTableSql()     — pure function to construct ALTER TABLE SQL (exported for testing)
 *   alterTableColumns()      — orchestrator function (checklist → SQL → confirm → execute)
 *   makeAlterTableColumnsTool() — factory returning SdkMcpToolDefinition
 */
import { z } from "zod";
import { input } from "../../output/themed-prompts.js";
import pc from "picocolors";
import { tool } from "@anthropic-ai/claude-agent-sdk";

import type { KineticaSession, ToolResult } from "../../types/index.js";
import { showChecklist, type ChecklistItem } from "../../approval/checklist.js";
import { executeMutationSql } from "./execute-mutation-sql.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ColumnChangeSchema = z.object({
  column_name: z.string().min(1),
  new_definition: z.string().min(1),
  description: z.string().min(1),
});

export const AlterTableColumnsSchema = z.object({
  table_name: z.string().min(1),
  rationale: z.string().min(1),
  columns: z.array(ColumnChangeSchema).min(2).max(50),
});

export type AlterTableColumnsInput = z.infer<typeof AlterTableColumnsSchema>;
type ColumnChange = z.infer<typeof ColumnChangeSchema>;

// ---------------------------------------------------------------------------
// SQL builder (pure)
// ---------------------------------------------------------------------------

type SelectedColumn = {
  readonly column_name: string;
  readonly new_definition: string;
};

/**
 * Builds a single ALTER TABLE statement with multiple ALTER COLUMN clauses.
 * Pure function — no I/O, no side effects.
 *
 * @param tableName - Fully-qualified table name (schema.table)
 * @param columns   - Selected columns with their new definitions
 * @returns ALTER TABLE SQL string
 */
export function buildAlterTableSql(tableName: string, columns: readonly SelectedColumn[]): string {
  const clauses = columns.map((c) => `  ALTER COLUMN ${c.column_name} ${c.new_definition}`);
  return `ALTER TABLE ${tableName}\n${clauses.join(",\n")}`;
}

// ---------------------------------------------------------------------------
// SQL preview + confirmation
// ---------------------------------------------------------------------------

const SQL_DIVIDER = pc.dim("─".repeat(60));

/**
 * Renders the generated SQL on stderr and prompts for y/n confirmation.
 * Returns true if the operator approves execution.
 */
async function confirmSqlExecution(sql: string): Promise<boolean> {
  const panel = [
    "",
    SQL_DIVIDER,
    `  ${pc.bold(pc.yellow("Generated SQL:"))}`,
    "",
    sql
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    "",
    SQL_DIVIDER,
    "",
  ].join("\n");

  process.stderr.write(panel);

  try {
    const response = await input({ message: "Execute? (y/n):" });
    return response.trim().toLowerCase() === "y";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Checklist item builder
// ---------------------------------------------------------------------------

/**
 * Builds ChecklistItem array from the column changes in the tool input.
 * Each item's label shows the column name and new definition.
 */
function buildChecklistItems(columns: readonly ColumnChange[]): readonly ChecklistItem[] {
  return columns.map((col) => ({
    label: `${col.column_name}: ${col.new_definition}`,
    description: col.description,
  }));
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

type AlterColumnsSuccessData = {
  readonly status: "executed" | "cancelled" | "declined";
  readonly sql?: string;
  readonly selected_count?: number;
  readonly total_count: number;
  readonly execution_result?: unknown;
};

/**
 * Orchestrates the batch ALTER TABLE column flow:
 * 1. Show checklist for column selection
 * 2. Build combined ALTER TABLE SQL
 * 3. Show SQL preview + y/n confirmation
 * 4. Execute via executeMutationSql
 *
 * Never throws — all error paths return ToolResult.
 *
 * @param session - Pre-authenticated Kinetica session
 * @param input   - Validated tool input (table_name, rationale, columns)
 * @returns ToolResult with execution status
 */
export async function alterTableColumns(
  session: KineticaSession,
  toolInput: AlterTableColumnsInput,
): Promise<ToolResult<AlterColumnsSuccessData>> {
  const { table_name, rationale, columns } = toolInput;

  // Step 1: Show checklist
  const items = buildChecklistItems(columns);
  const selection = await showChecklist(
    "ALTER TABLE Column Changes",
    `Table: ${table_name}\n  ${rationale}`,
    items,
  );

  if (selection.action === "cancelled") {
    return {
      ok: true,
      data: {
        status: "cancelled",
        total_count: columns.length,
      },
    };
  }

  // Step 2: Build SQL from selected columns
  const selectedColumns: readonly SelectedColumn[] = selection.selectedIndices.map((i) => {
    const col = columns[i];
    return {
      column_name: col.column_name,
      new_definition: col.new_definition,
    };
  });

  const sql = buildAlterTableSql(table_name, selectedColumns);

  // Step 3: SQL preview + confirmation
  const confirmed = await confirmSqlExecution(sql);
  if (!confirmed) {
    return {
      ok: true,
      data: {
        status: "declined",
        sql,
        selected_count: selectedColumns.length,
        total_count: columns.length,
      },
    };
  }

  // Step 4: Execute
  const result = await executeMutationSql(session, sql);

  if (!result.ok) {
    return result;
  }

  return {
    ok: true,
    data: {
      status: "executed",
      sql,
      selected_count: selectedColumns.length,
      total_count: columns.length,
      execution_result: result.data,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/** Dependencies injected by the barrel module to avoid circular imports. */
export type OutputPipelineDeps = {
  readonly applyOutputPipeline: (result: { ok: boolean; data?: unknown }) => string;
  readonly logMutationAudit: (
    toolName: string,
    result: { ok: boolean; data?: unknown },
    input: object,
  ) => void;
};

/**
 * Creates the SdkMcpToolDefinition for kinetica_alter_table_columns.
 *
 * This tool is added to ALLOWED_TOOL_NAMES (bypasses the SDK approval gate)
 * because it implements its own two-step approval: checklist + SQL preview.
 *
 * @param session - Pre-authenticated Kinetica session
 * @param deps    - Output pipeline functions (injected from tools/index.ts)
 * @returns SdkMcpToolDefinition for the ALTER TABLE columns tool
 */
export function makeAlterTableColumnsTool(session: KineticaSession, deps: OutputPipelineDeps) {
  return tool(
    "kinetica_alter_table_columns",
    "Batch multiple column type/property changes on a SINGLE table into one efficient ALTER TABLE statement. Use when recommending 2+ column changes on the same table (e.g., adding DICT encoding to multiple columns, adding TEXT_SEARCH, changing column types). Each column change requires: column_name, new_definition (full type definition with properties and nullability), and description (human-readable reason). The operator selects which columns to alter via interactive checklist, then confirms the generated SQL. For a single column change, use kinetica_execute_mutation_sql directly. Kinetica ALTER TABLE syntax requires repeating the FULL column definition — properties go INSIDE parentheses: VARCHAR(50, DICT), not VARCHAR(50) DICT.",
    AlterTableColumnsSchema.shape,
    async (args: Record<string, unknown>) => {
      const parsed = AlterTableColumnsSchema.parse(args);
      const result = await alterTableColumns(session, parsed);
      deps.logMutationAudit("kinetica_alter_table_columns", result, {
        table_name: parsed.table_name,
        columns_proposed: parsed.columns.length,
      });
      return {
        content: [{ type: "text" as const, text: deps.applyOutputPipeline(result) }],
      };
    },
    { annotations: { destructive: true, readOnly: false } },
  );
}
