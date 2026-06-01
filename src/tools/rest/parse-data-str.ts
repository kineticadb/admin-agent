/**
 * parseDataStr — shared double-decode utility for Kinetica REST responses.
 *
 * Kinetica REST endpoints return `data_str` as a JSON-encoded string
 * (double-encoding). This function safely parses that inner JSON string
 * into a typed object.
 *
 * Returns a discriminated union:
 *   - { ok: true, data: T | undefined }  — parse succeeded (or input was not a string)
 *   - { ok: false, ... }                 — parse failed with error details
 *
 * Never throws.
 */
import type { ToolFailure } from "../../types/index.js";

type ParseSuccess<T> = { readonly ok: true; readonly data: T | undefined };
type ParseDataStrResult<T> = ParseSuccess<T> | ToolFailure;

export function parseDataStr<T>(outerDataStr: unknown, raw: string): ParseDataStrResult<T> {
  if (typeof outerDataStr !== "string") {
    return { ok: true, data: undefined };
  }
  try {
    return { ok: true, data: JSON.parse(outerDataStr) as T };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 200, error: `data_str parse error: ${message}`, raw };
  }
}
