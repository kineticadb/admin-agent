/**
 * Safely stringify an unknown value to a display-ready string.
 *
 * Objects are JSON-encoded rather than rendered as "[object Object]".
 * Use when formatting cell values, log lines, or any unknown input where
 * the shape may include primitives or nested objects.
 */
export function stringifyValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return v.toString();
  }
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "symbol") return v.toString();
  return "";
}
