/**
 * renderMarkdownLine — convert markdown in a SINGLE line to terminal-styled text
 * (picocolors ANSI). This is the sole styling path for the agent's streamed prose,
 * so its job is to turn an undifferentiated wall of white text into a scannable
 * hierarchy: colored section headers, rules, bullets, inline code, and semantic
 * severity tints.
 *
 * Line-scoped by design — the streaming aligner feeds one complete line at a time,
 * so only single-line constructs are handled (multi-line blocks like fenced code
 * would need the aligner to buffer them, the way it already buffers `|…|` tables).
 *
 * Pure. Never throws. picocolors auto-disables on non-TTY / NO_COLOR, so output
 * degrades to plain text in pipes, CI, and anything redirected to a file.
 */
import pc from "picocolors";
import { purple, pink } from "./brand-colors.js";

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const HRULE_RE = /^\s*([-*_])\1{2,}\s*$/; // ---, ***, ___ (3 or more)
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/; // "- item", "  * item", "+ item"
const BOLD_RE = /\*\*(.+?)\*\*/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const UPPERWORD_RE = /[A-Z]{2,}/; // cheap gate: every severity token is 2+ uppercase letters
const ANSI_RE = /\x1b\[[0-9;]*m/g; // SGR escapes picocolors emits; stripped to measure width

/** Terminal width, falling back to 80 when not attached to a TTY (tests, pipes). */
const DEFAULT_WIDTH = 80;
function terminalWidth(): number {
  const cols = process.stderr.columns;
  return typeof cols === "number" && cols > 0 ? cols : DEFAULT_WIDTH;
}

/**
 * Semantic severity rules, highest priority first. Tokens are matched as
 * case-SENSITIVE whole words: in Kinetica output severities appear uppercase
 * (FATAL/ERROR/WARN/…), so this lights up real severities while leaving prose like
 * "no errors" (lowercase) untouched. This list is the single tuning point for
 * which words get colored and which glyph a finding bullet gets.
 */
interface SeverityRule {
  readonly re: RegExp;
  readonly color: (s: string) => string;
  readonly glyph: string;
}
const SEVERITY_RULES: readonly SeverityRule[] = [
  { re: /\b(FATAL|ERROR|UERR|CRITICAL|SEGV|SIGSEGV)\b/, color: pc.red, glyph: "✗" },
  { re: /\b(WARN|WARNING)\b/, color: pc.yellow, glyph: "⚠" },
  { re: /\b(OK|PASS|PASSED|HEALTHY)\b/, color: pc.green, glyph: "✓" },
];

/**
 * First severity rule whose token appears in `text`, else undefined. The single
 * definition of "scan for a severity", shared by styleInline (which tints the match)
 * and bulletFor (which uses the match's glyph) so the two can't drift.
 */
function firstSeverityRule(text: string): SeverityRule | undefined {
  return SEVERITY_RULES.find((rule) => rule.re.test(text));
}

/**
 * Inline styling shared by prose, list items, and table cells: inline code, bold,
 * severity tint. Exported so the table reformatter can style cells WITHOUT the
 * block-level constructs (headings/rules/bullets) that must never fire inside a cell.
 *
 * Each pass is gated by a cheap pre-check: this runs on EVERY streamed output line,
 * and the bulk of that is plain lowercase prose with no markup. An unconditional
 * replace allocates a new string per pass even when nothing matches, so the guards
 * keep the common case to a substring scan and zero allocations.
 */
export function styleInline(text: string): string {
  let out = text;
  if (out.includes("`")) out = out.replace(INLINE_CODE_RE, (_, code: string) => purple(code));
  if (out.includes("**")) out = out.replace(BOLD_RE, (_, b: string) => pc.bold(b));
  if (UPPERWORD_RE.test(out)) {
    for (const rule of SEVERITY_RULES) {
      out = out.replace(rule.re, (token) => rule.color(token));
    }
  }
  return out;
}

/** Pick a colored bullet glyph from a list item's severity, else a brand-purple dot. */
function bulletFor(itemText: string): string {
  const rule = firstSeverityRule(itemText);
  return rule ? rule.color(rule.glyph) : purple("•");
}

/**
 * Visible width of `text` after inline styling — the rendered length, excluding the
 * markdown markers styleInline strips (code backticks, bold fences) and the ANSI it
 * adds. Derives width from styleInline's actual output so table column padding stays
 * correct by construction, instead of a hand-maintained mirror of its strip set.
 */
export function visibleWidth(text: string): number {
  return styleInline(text).replace(ANSI_RE, "").length;
}

export function renderMarkdownLine(line: string): string {
  // Horizontal rule → dim full-width line.
  if (HRULE_RE.test(line)) {
    return pc.dim("─".repeat(terminalWidth()));
  }

  // Headings → colored by level, with a leading blank line so sections separate.
  const heading = HEADING_RE.exec(line);
  if (heading) {
    const level = heading[1].length;
    const text = heading[2];
    if (level === 1) {
      // Title: bold brand-pink with an underline rule beneath.
      return `\n${pc.bold(pink(text))}\n${pc.dim("─".repeat(terminalWidth()))}`;
    }
    if (level === 2) {
      // Section: accent bar + bold brand-pink, preceded by a blank line.
      return `\n${pc.bold(pink(`▌ ${text}`))}`;
    }
    // Sub-section (h3–h6): bold brand-purple, kept tight (no extra spacing).
    return pc.bold(purple(text));
  }

  // List item → colored glyph + inline-styled content, indentation preserved.
  const bullet = BULLET_RE.exec(line);
  if (bullet) {
    const [, indent, item] = bullet;
    return `${indent}${bulletFor(item)} ${styleInline(item)}`;
  }

  // Plain line → inline styling only (code, bold, severity).
  return styleInline(line);
}
