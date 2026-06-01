/**
 * Streaming table aligner — line-buffering adapter that detects markdown table
 * blocks in streamed text deltas, reformats them with aligned columns and
 * box-drawing borders, and passes non-table content through immediately.
 *
 * Trade-off: streaming changes from character-by-character to line-by-line.
 * This adds negligible latency for prose (LLM generates fast enough that
 * partial-line delays are imperceptible) while enabling proper table alignment.
 */

import { reformatTableBlock } from "./reformat-tables.js";
import { renderMarkdownLine } from "./render-markdown.js";

const TABLE_LINE_RE = /^\|.*\|$/;

/** Public interface returned by the factory. */
export interface StreamingTableAligner {
  /** Feed a text delta. Returns any displayable output (may be empty). */
  readonly push: (text: string) => string;
  /** Flush remaining buffers (call at end of turn). Returns any remaining output. */
  readonly flush: () => string;
}

/**
 * Creates a streaming table aligner.
 *
 * Non-table lines pass through immediately (line-by-line).
 * Table lines (`| ... |`) are buffered until the block ends,
 * then flushed through reformatTableBlock for alignment.
 */
export function createStreamingTableAligner(): StreamingTableAligner {
  let lineBuffer = "";
  let tableLines: string[] = [];

  /** Flush pending table lines through the reformatter. */
  function flushTable(): string {
    if (tableLines.length === 0) return "";
    const aligned = reformatTableBlock(tableLines);
    tableLines = [];
    return aligned.join("\n") + "\n";
  }

  function push(text: string): string {
    if (!text) return "";

    // Prepend any leftover partial line from previous push
    const combined = lineBuffer + text;
    const segments = combined.split("\n");

    // Last segment is either empty (text ended with \n) or an incomplete line
    lineBuffer = segments[segments.length - 1];

    // Process all complete lines (everything except the last segment)
    const completeLines = segments.slice(0, -1);
    let output = "";

    for (const line of completeLines) {
      const trimmed = line.trim();
      if (TABLE_LINE_RE.test(trimmed)) {
        // Table line — buffer it
        tableLines.push(trimmed);
      } else {
        // Non-table line — flush any pending table first, then render and output
        output += flushTable();
        output += renderMarkdownLine(line) + "\n";
      }
    }

    return output;
  }

  function flush(): string {
    let output = flushTable();
    if (lineBuffer) {
      output += renderMarkdownLine(lineBuffer);
      lineBuffer = "";
    }
    return output;
  }

  return Object.freeze({ push, flush });
}
