/**
 * renderMarkdownLine — converts markdown syntax in a single line to
 * terminal-styled text using picocolors ANSI codes.
 *
 * Supported patterns:
 *   **text**   → bold
 *   ## heading → bold (# prefix stripped)
 *
 * Pure function. Never throws. Returns input unchanged if no patterns match.
 */
import pc from "picocolors";

const BOLD_RE = /\*\*(.+?)\*\*/g;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

export function renderMarkdownLine(line: string): string {
  // Headers: strip # prefix, bold the text
  const headingMatch = HEADING_RE.exec(line);
  if (headingMatch) {
    return pc.bold(headingMatch[2]);
  }

  // Bold spans: replace **text** with terminal bold
  if (line.includes("**")) {
    return line.replace(BOLD_RE, (_, text: string) => pc.bold(text));
  }

  return line;
}
