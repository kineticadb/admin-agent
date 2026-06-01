/**
 * Reshape utilities — convert objects to row arrays for table rendering.
 *
 * These pure functions bridge the gap between Kinetica API responses (objects/
 * nested objects) and formatOutput()'s markdown table renderer (which requires
 * Array<object>).
 *
 * Both functions are immutable — inputs are never mutated.
 */

/**
 * Safely convert a value to string. Objects become JSON to prevent
 * `[object Object]` from escaping the output pipeline.
 */
function safeString(v: unknown): string {
  if (typeof v === "object" && v !== null) {
    return JSON.stringify(v);
  }
  return String(v);
}

/**
 * Converts a flat object into an array of two-column rows.
 *
 * { a: "x", b: "y" } → [{ key: "a", value: "x" }, { key: "b", value: "y" }]
 */
export function flatObjectToRows(
  obj: Record<string, unknown>,
  keyLabel = "key",
  valueLabel = "value",
): Record<string, string>[] {
  return Object.entries(obj).map(([k, v]) => ({
    [keyLabel]: k,
    [valueLabel]: safeString(v),
  }));
}

/**
 * Converts a nested object into an array of flattened rows.
 *
 * { node_0: { cpu: "50%" }, node_1: { cpu: "60%", gpu: "80%" } }
 * → [{ name: "node_0", cpu: "50%", gpu: "" }, { name: "node_1", cpu: "60%", gpu: "80%" }]
 *
 * Entries whose values are not plain objects are skipped.
 * Missing keys across sub-objects are filled with "".
 */
export function nestedObjectToRows(
  obj: Record<string, Record<string, unknown>>,
  keyLabel = "name",
): Record<string, string>[] {
  // Filter to entries whose values are plain objects
  const entries = Object.entries(obj).filter(
    ([, v]) => typeof v === "object" && v !== null && !Array.isArray(v),
  );

  if (entries.length === 0) return [];

  // Collect the union of all sub-object keys (preserving insertion order)
  const allKeys = new Set<string>();
  for (const [, sub] of entries) {
    for (const k of Object.keys(sub)) {
      allKeys.add(k);
    }
  }

  return entries.map(([name, sub]) => {
    const row: Record<string, string> = { [keyLabel]: name };
    for (const k of allKeys) {
      row[k] = k in sub ? safeString(sub[k]) : "";
    }
    return row;
  });
}
