/**
 * decodeNestedJsonStrings — recursively decode JSON-encoded string values.
 *
 * Kinetica triple-encodes some REST responses: statistics_map.ranks is a JSON
 * string containing per-rank entries that are themselves JSON strings.
 *
 * This function walks an object and for every string value, attempts JSON.parse.
 * If the parsed result is a plain object, the function recurses into it.
 * Non-JSON strings and non-object parsed values are returned as-is.
 *
 * Pure function — never throws, never mutates input.
 */
export function decodeNestedJsonStrings(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => {
      if (typeof v !== "string") return [k, v];
      try {
        const parsed = JSON.parse(v) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return [k, decodeNestedJsonStrings(parsed as Record<string, unknown>)];
        }
        return [k, parsed];
      } catch {
        return [k, v];
      }
    }),
  );
}
