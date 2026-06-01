/**
 * formatOutput — converts raw JSON data to a markdown string.
 *
 * Pipeline: Kinetica JSON → formatOutput() → truncateOutput() → agent
 *
 * Rules:
 *   null/undefined          → "(empty)"
 *   []                      → "(no results)"
 *   Array<object>           → markdown table (headers from first element keys)
 *   Array<primitive>        → each element on its own line
 *   object (flat)           → "**key:** value" per entry, joined by "\n"
 *   object (nested value)   → "**key:**\n{recursive result}"
 *   primitive               → String(json)
 *
 * Pure function — never mutates input, always returns a new string.
 */
import { stringifyValue } from "./stringify.js";

export function formatOutput(json: unknown): string {
  if (json === null || json === undefined) {
    return "(empty)";
  }

  if (Array.isArray(json)) {
    return formatArray(json);
  }

  if (typeof json === "object") {
    return formatObject(json as Record<string, unknown>);
  }

  return stringifyValue(json);
}

function formatArray(arr: unknown[]): string {
  if (arr.length === 0) {
    return "(no results)";
  }

  const first = arr[0];
  if (typeof first === "object" && first !== null && !Array.isArray(first)) {
    return formatTableArray(arr as Record<string, unknown>[]);
  }

  return arr.map(stringifyValue).join("\n");
}

function formatTableArray(rows: Record<string, unknown>[]): string {
  const headers = Object.keys(rows[0]);

  const cells = rows.map((row) => headers.map((h) => stringifyValue(row[h])));

  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((row) => row[i].length), 3),
  );

  const pad = (text: string, col: number) => text.padEnd(colWidths[col]);

  const headerRow = `| ${headers.map((h, i) => pad(h, i)).join(" | ")} |`;
  const separatorRow = `| ${colWidths.map((w) => "-".repeat(w)).join(" | ")} |`;
  const dataRows = cells.map((row) => `| ${row.map((cell, i) => pad(cell, i)).join(" | ")} |`);

  return [headerRow, separatorRow, ...dataRows].join("\n");
}

function formatObject(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([key, value]) => {
      if (typeof value === "object" && value !== null) {
        return `**${key}:**\n${formatOutput(value)}`;
      }
      return `**${key}:** ${stringifyValue(value)}`;
    })
    .join("\n");
}
