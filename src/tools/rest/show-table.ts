/**
 * showTable — retrieves Kinetica table metadata.
 *
 * Endpoint: POST /show/table
 * Returns: zipped array of { table_name, description, size, properties }
 * from parallel arrays in data_str.
 *
 * When a specific table_name is provided, automatically requests column info
 * (get_column_info: "true") and returns enriched output with Kinetica-native
 * column types and per-column properties parsed from type_schemas.
 *
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import { z } from "zod";
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { parseTypeSchema } from "./parse-type-schema.js";

/**
 * Zod schema for showTable input parameters.
 * Exported for MCP tool registration.
 */
export const ShowTableSchema = z.object({
  table_name: z.string().optional().default(""),
  get_sizes: z.boolean().optional(),
  get_access_data: z.boolean().optional(),
  get_column_info: z.boolean().optional(),
});

/** Input type inferred from ShowTableSchema */
export type ShowTableInput = z.infer<typeof ShowTableSchema>;

type TableEntry = {
  readonly table_name: string;
  readonly description: string;
  readonly size: string;
  readonly properties: string;
};

type ColumnEntry = {
  readonly name: string;
  readonly type: string;
  readonly properties: string;
};

type IndexEntry = {
  readonly index_type: string;
  readonly index_columns: string;
};

/** Outer response — data_str is a JSON-encoded string (double-encoding). */
type ShowTableResponse = {
  data_str?: string;
};

/** Inner structure after second JSON.parse of data_str. */
type ShowTableData = {
  table_names?: string[];
  table_descriptions?: string[];
  sizes?: string[];
  properties?: string[];
  type_schemas?: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the get_column_info option value based on inputs.
 * - Explicitly set → use that value
 * - table_name non-empty and not explicitly false → "true"
 * - Otherwise → "false"
 */
function resolveColumnInfoOption(input: ShowTableInput): string {
  if (input.get_column_info === true) return "true";
  if (input.get_column_info === false) return "false";
  // Auto-enable when targeting a specific table
  return input.table_name !== "" ? "true" : "false";
}

/**
 * Parse a per-table properties string as JSON to extract per-column properties.
 * Returns a map of column_name → comma-separated property list.
 * Returns empty map on any failure.
 */
function parseColumnProperties(propertiesJson: string): ReadonlyMap<string, string> {
  try {
    const parsed = JSON.parse(propertiesJson) as Record<string, unknown>;
    const result = new Map<string, string>();
    for (const [colName, props] of Object.entries(parsed)) {
      if (Array.isArray(props)) {
        result.set(colName, props.join(", "));
      }
    }
    return result;
  } catch {
    return new Map();
  }
}

/**
 * Build enriched column entries by merging type_schemas info with per-column properties.
 */
function buildColumnEntries(
  typeSchemaJson: string | undefined,
  propertiesStr: string | undefined,
): readonly ColumnEntry[] {
  if (!typeSchemaJson) return [];

  const columnInfos = parseTypeSchema(typeSchemaJson);
  if (columnInfos.length === 0) return [];

  const propsMap =
    propertiesStr !== undefined ? parseColumnProperties(propertiesStr) : new Map<string, string>();

  return columnInfos.map((col) => ({
    name: col.name,
    type: col.type,
    properties: propsMap.get(col.name) ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Index fetching
// ---------------------------------------------------------------------------

/** Escape a SQL string literal value (double single quotes). */
function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Parse a schema-qualified table name ("schema.table") into components.
 * Returns null when the name has no dot (cannot determine schema).
 */
function splitSchemaTable(
  tableName: string,
): { readonly schema: string; readonly table: string } | null {
  const dot = tableName.indexOf(".");
  if (dot === -1) return null;
  return { schema: tableName.slice(0, dot), table: tableName.slice(dot + 1) };
}

/** Inner data_str shape from /execute/sql (only fields we need). */
type SqlDataStr = {
  readonly json_encoded_response: string;
  readonly total_number_of_records: number;
};

/**
 * Fetch indexes for a specific table from ki_catalog.ki_indexes via SQL.
 * Returns empty array on any error (graceful degradation — never throws).
 */
async function fetchIndexes(
  session: KineticaSession,
  tableName: string,
): Promise<readonly IndexEntry[]> {
  const parts = splitSchemaTable(tableName);
  if (!parts) return [];

  const schema = escapeSqlString(parts.schema);
  const table = escapeSqlString(parts.table);
  const statement = `SELECT index_type, index_columns FROM ki_catalog.ki_indexes WHERE schema_name = '${schema}' AND object_name = '${table}'`;

  try {
    const response = await session.makeRequest("/execute/sql", {
      statement,
      offset: 0,
      limit: 100,
      encoding: "json",
      options: {},
    });

    if (!response.ok) return [];

    const rawText = await response.text();
    const outer = JSON.parse(rawText) as { status: string; data_str: string };
    if (outer.status === "ERROR") return [];

    const dataStr = JSON.parse(outer.data_str) as SqlDataStr;
    if (dataStr.total_number_of_records === 0) return [];

    const cols = JSON.parse(dataStr.json_encoded_response) as Record<string, readonly string[]>;
    const types = cols.column_1 ?? [];
    const indexCols = cols.column_2 ?? [];

    return types.map((t, i) => ({
      index_type: t,
      index_columns: indexCols[i] ?? "",
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Shows table metadata: names, descriptions, sizes, properties, and
 * Kinetica-native column types when a specific table is targeted.
 *
 * @param session - Pre-authenticated Kinetica session
 * @param input   - Optional table_name filter, size/access/column_info flags
 * @returns ToolResult with table metadata (enriched with columns when applicable)
 */
export async function showTable(
  session: KineticaSession,
  input: ShowTableInput,
): Promise<ToolResult<unknown>> {
  // Build options object — conditionally add get_access_data
  const options: Record<string, string> = {
    get_sizes: String(input.get_sizes ?? true),
    show_children: "false",
    no_error_if_not_exists: "true",
    get_column_info: resolveColumnInfoOption(input),
  };

  if (input.get_access_data !== undefined) {
    options.get_access_data = String(input.get_access_data);
  }

  try {
    const response = await session.makeRequest("/show/table", {
      table_name: input.table_name,
      options,
    });

    if (!response.ok) {
      const raw = await response.text();
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
        raw,
      };
    }

    const raw = await response.text();
    let outer: ShowTableResponse;
    try {
      outer = JSON.parse(raw) as ShowTableResponse;
    } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      return {
        ok: false,
        status: 200,
        error: `JSON parse error: ${message}`,
        raw,
      };
    }

    // Double-decode: data_str is a JSON-encoded string (same as /execute/sql)
    let inner: ShowTableData = {};
    if (typeof outer.data_str === "string") {
      try {
        inner = JSON.parse(outer.data_str) as ShowTableData;
      } catch (parseError) {
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        return {
          ok: false,
          status: 200,
          error: `data_str parse error: ${message}`,
          raw,
        };
      }
    }

    const tableNames = inner.table_names ?? [];
    const descriptions = inner.table_descriptions ?? [];
    const sizes = inner.sizes ?? [];
    const properties = inner.properties ?? [];
    const typeSchemas = inner.type_schemas;

    // Single table with column info → enriched output
    if (options.get_column_info === "true" && tableNames.length > 0) {
      const table: TableEntry = {
        table_name: tableNames[0],
        description: descriptions[0] ?? "",
        size: sizes[0] ?? "",
        properties: properties[0] ?? "",
      };

      const columns = buildColumnEntries(typeSchemas?.[0], typeSchemas ? properties[0] : undefined);

      const indexes = await fetchIndexes(session, input.table_name);

      return {
        ok: true,
        data: { table, columns, indexes },
      };
    }

    // List-all mode or no column info → flat array
    const data: ReadonlyArray<TableEntry> = tableNames.map((name, i) => ({
      table_name: name,
      description: descriptions[i] ?? "",
      size: sizes[i] ?? "",
      properties: properties[i] ?? "",
    }));

    return {
      ok: true,
      data,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      error: message,
      raw: "",
    };
  }
}
