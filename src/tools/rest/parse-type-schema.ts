/**
 * Parse Avro-like type_schemas JSON from /show/table responses.
 *
 * When `/show/table` is called with `get_column_info: "true"`, each entry
 * in the `type_schemas[]` parallel array is a JSON string describing
 * column names and their Kinetica-native types (int, long, string, etc.).
 *
 * Never throws — returns empty array on any parse failure.
 * Never mutates input.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ColumnInfo = {
  readonly name: string;
  readonly type: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the concrete type from an Avro union array like ["string", "null"].
 * Returns the first non-"null" element, or "null" if all elements are "null".
 */
function resolveUnionType(union: readonly unknown[]): string {
  for (const entry of union) {
    if (typeof entry === "string" && entry !== "null") {
      return entry;
    }
  }
  return "null";
}

/**
 * Resolves an Avro field type to a simple type string.
 * - String type → returned as-is
 * - Array (union) → first non-null type extracted
 * - Anything else → undefined (field will be skipped)
 */
function resolveFieldType(fieldType: unknown): string | undefined {
  if (typeof fieldType === "string") {
    return fieldType;
  }
  if (Array.isArray(fieldType)) {
    return resolveUnionType(fieldType);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse an Avro-like type schema JSON string into column info entries.
 *
 * @param schemaJson - JSON string from `type_schemas[i]` in /show/table response
 * @returns Readonly array of column name/type pairs. Empty array on any failure.
 */
export function parseTypeSchema(schemaJson: string): readonly ColumnInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaJson);
  } catch {
    return [];
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("type" in parsed) ||
    !("fields" in parsed)
  ) {
    return [];
  }

  const record = parsed;

  if (record.type !== "record" || !Array.isArray(record.fields)) {
    return [];
  }

  const columns: ColumnInfo[] = [];

  for (const field of record.fields) {
    if (typeof field !== "object" || field === null) continue;

    const f = field as { name?: unknown; type?: unknown };
    if (typeof f.name !== "string" || f.type === undefined) continue;

    const resolvedType = resolveFieldType(f.type);
    if (resolvedType === undefined) continue;

    columns.push({ name: f.name, type: resolvedType });
  }

  return columns;
}
