/**
 * reformatTables — post-processes markdown text to align table columns.
 *
 * LLMs produce structurally correct markdown tables but cannot count
 * characters precisely, so columns misalign in monospace terminal output.
 * This pure function detects markdown table blocks in free-form text and
 * re-pads every column to uniform width.
 *
 * Non-table content passes through unchanged.
 */

import { renderMarkdownLine } from "./render-markdown.js";

const TABLE_LINE_RE = /^\|.*\|$/;
const SEPARATOR_CELL_RE = /^:?-+:?$/;
const BOLD_MARKERS_RE = /\*\*(.+?)\*\*/g;

/** Returns the visual width of text, excluding invisible markdown markers like **. */
function visualWidth(text: string): number {
  return text.replace(BOLD_MARKERS_RE, "$1").length;
}

/** Returns true if a trimmed cell looks like a separator (e.g. ---, :--:, ---:). */
function isSeparatorCell(cell: string): boolean {
  return SEPARATOR_CELL_RE.test(cell);
}

/** Returns true if every cell in the row is a separator. */
function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every(isSeparatorCell);
}

/** Parse a table line into trimmed cell strings (strips outer pipes). */
function parseCells(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
}

/** Reformat a single table block (array of raw lines) into aligned lines. */
export function reformatTableBlock(lines: readonly string[]): string[] {
  // Parse all rows into cells
  const parsed = lines.map(parseCells);

  // Determine the max column count across all rows
  const colCount = Math.max(...parsed.map((row) => row.length));

  // Normalise each row to have exactly colCount cells
  const normalised = parsed.map((row) => {
    const padded = [...row];
    while (padded.length < colCount) {
      padded.push("");
    }
    return padded;
  });

  // Compute max visual width per column (min 3 for valid "---" separators).
  // Uses visualWidth to exclude invisible markdown markers like **.
  // Skip separator rows when measuring widths.
  const colWidths = Array.from({ length: colCount }, (_, col) =>
    Math.max(
      3,
      ...normalised.filter((row) => !isSeparatorRow(row)).map((row) => visualWidth(row[col])),
    ),
  );

  // Build border/separator row with + corners: +-------+-----+
  const borderRow = `+${colWidths.map((w) => "-".repeat(w + 2)).join("+")}+`;

  // Rebuild each row — separator rows become borderRow, data rows keep | pipes
  const bodyRows = normalised.map((row) => {
    if (isSeparatorRow(row)) {
      return borderRow;
    }
    const cells = row.map((cell, col) => {
      const rendered = renderMarkdownLine(cell);
      const pad = colWidths[col] - visualWidth(cell);
      return rendered + " ".repeat(Math.max(0, pad));
    });
    return `| ${cells.join(" | ")} |`;
  });

  return [borderRow, ...bodyRows, borderRow];
}

/**
 * Detects markdown table blocks in text and re-pads columns to uniform width.
 *
 * Pure function — never mutates input, always returns a new string.
 */
export function reformatTables(text: string): string {
  if (!text) return text;

  const lines = text.split("\n");
  const result: string[] = [];
  let tableBuffer: string[] = [];

  const flushTable = (): void => {
    if (tableBuffer.length > 0) {
      result.push(...reformatTableBlock(tableBuffer));
      tableBuffer = [];
    }
  };

  for (const line of lines) {
    if (TABLE_LINE_RE.test(line.trim())) {
      tableBuffer.push(line.trim());
    } else {
      flushTable();
      result.push(line);
    }
  }
  flushTable();

  return result.join("\n");
}
