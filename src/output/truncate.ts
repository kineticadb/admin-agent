import { DEFAULT_TRUNCATION, type TruncationOptions } from "../types/index.js";

/**
 * Truncate tool output to a head+tail structure to protect against context window exhaustion.
 *
 * If the text has more lines than headLines + tailLines, the middle section is replaced
 * with a truncation indicator showing the exact number of omitted lines.
 *
 * This function is pure: it does not mutate its arguments and always returns a new string.
 *
 * @param text - The text to potentially truncate
 * @param options - Truncation configuration (defaults to DEFAULT_TRUNCATION: 150 head + 50 tail)
 * @returns The original text if under threshold, or a truncated version with indicator
 */
export function truncateOutput(
  text: string,
  options: TruncationOptions = DEFAULT_TRUNCATION,
): string {
  if (text === "") return "";

  const lines = text.split("\n");
  const { headLines, tailLines } = options;
  const threshold = headLines + tailLines;

  if (lines.length <= threshold) {
    return text;
  }

  const truncatedCount = lines.length - headLines - tailLines;
  const head = lines.slice(0, headLines);
  const tail = lines.slice(lines.length - tailLines);

  return [...head, "", `[... ${truncatedCount} lines truncated ...]`, "", ...tail].join("\n");
}
