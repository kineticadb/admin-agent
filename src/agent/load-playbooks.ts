/**
 * Playbook loader — reads expert diagnostic knowledge from knowledge/playbooks/*.md.
 *
 * Each playbook is a Markdown file with YAML frontmatter (title, category, severity, keywords)
 * and a body containing symptoms, detection steps, root cause, and remediation guidance.
 *
 * Exports:
 *   parseFrontmatter(raw) — parse YAML frontmatter from markdown string (exported for testing + reuse)
 *   extractBody(raw)      — extract markdown body after frontmatter (exported for testing + reuse)
 *   findPackageRoot(dir)  — walk up to package.json (exported for reuse by load-references.ts)
 *   loadPlaybooks(dir?)   — load all playbooks from directory, returns readonly Playbook[]
 *
 * Design:
 *   - No external YAML dependency — lightweight parser handles flat key-value frontmatter
 *   - Returns empty array on any error (graceful degradation, same pattern as discoverCatalogSchemas)
 *   - Never throws
 *   - Resolves playbooks directory relative to package root (works in both dev/tsx and bundled/CJS)
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import type { Disclosure, Playbook } from "../types/index.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Walk up from startDir to find the directory containing package.json.
 * Returns startDir as fallback if filesystem root is reached (graceful degradation).
 */
export function findPackageRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return startDir;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/** Parsed frontmatter fields from a playbook or reference file. */
type FrontmatterFields = {
  readonly title: string;
  readonly category: string;
  readonly severity: string;
  readonly keywords: readonly string[];
  /** One line stating WHAT the document covers. Absent unless authored. */
  readonly summary?: string;
  /** The unconditional trigger for reading it (`read_when`). Absent unless authored. */
  readonly readWhen?: string;
  /** Only set when the value is a known literal — the default is applied downstream. */
  readonly disclosure?: Disclosure;
};

/**
 * A line that STARTS a new key: non-space first character, then a colon before
 * any other colon-free run ends. Anything else in a frontmatter block is a
 * continuation of the value above it.
 */
const KEY_LINE = /^\S[^:]*:/;

/**
 * Fold continuation lines into the key line above them.
 *
 * Prettier reflows any frontmatter array wider than `printWidth` onto several
 * lines (`keywords:` then `  [`, `    item,`, … `  ]`). Read line by line that
 * leaves `keywords` with an empty value and silently drops every item — the
 * bug that left 7 of 12 references with zero keywords. Folding first restores a
 * single `key: value` line, so the bracket-array branch below works unchanged.
 *
 * Blank lines are dropped rather than folded, so they cannot pad a value.
 */
function foldContinuations(lines: readonly string[]): readonly string[] {
  return lines.reduce<readonly string[]>((acc, line) => {
    if (acc.length === 0 || KEY_LINE.test(line)) return [...acc, line];
    const trimmed = line.trim();
    if (!trimmed) return acc;
    return [...acc.slice(0, -1), `${acc[acc.length - 1]} ${trimmed}`];
  }, []);
}

/**
 * Strip one layer of matching surrounding quotes.
 *
 * Required, not cosmetic: a value containing `: ` (e.g. "Master config file:
 * section index, …") is invalid unquoted YAML, so Prettier keeps the quotes and
 * an unstripped value would carry them into the rendered prompt.
 */
function unquote(value: string): string {
  const quoted = /^"([\s\S]*)"$/.exec(value) ?? /^'([\s\S]*)'$/.exec(value);
  return quoted ? quoted[1] : value;
}

/** Parse a bracket array (`[a, b, c]`) into its trimmed, non-empty items. */
function parseArray(value: string): readonly string[] {
  if (!value.startsWith("[") || !value.endsWith("]")) return [];
  return value
    .slice(1, -1)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Narrow a raw frontmatter value to a Disclosure, or undefined when unrecognized. */
function parseDisclosure(value: string | undefined): Disclosure | undefined {
  return value === "inline" || value === "on-demand" ? value : undefined;
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Expects content starting with `---\n...\n---\n`.
 * Returns null if frontmatter is missing or the required `title` field is absent.
 *
 * Handles:
 * - Flat key: value pairs
 * - Bracket arrays: [item1, item2, item3], including Prettier's multi-line reflow
 * - Quoted values, so a value may contain a colon
 * - Both LF and CRLF line endings
 * - Defaults for optional fields (category → "general", severity → "info")
 *
 * `disclosure` is deliberately left undefined for an unrecognized value rather than
 * defaulting here: the default belongs to normalization, which is the one place that
 * decides it, so a typo cannot silently mean something different in two places.
 */
export function parseFrontmatter(raw: string): FrontmatterFields | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return null;

  const fields: Record<string, string> = {};

  for (const line of foldContinuations(match[1].split(/\r?\n/))) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = unquote(line.slice(colonIdx + 1).trim());
    if (key) fields[key] = value;
  }

  const title = fields.title;
  if (!title) return null;

  return {
    title,
    category: fields.category ?? "general",
    severity: fields.severity ?? "info",
    keywords: parseArray(fields.keywords ?? ""),
    summary: fields.summary || undefined,
    readWhen: fields.read_when || undefined,
    disclosure: parseDisclosure(fields.disclosure),
  };
}

// ---------------------------------------------------------------------------
// Body extraction
// ---------------------------------------------------------------------------

/**
 * Extract the markdown body after frontmatter.
 * Returns the trimmed content after the closing `---` delimiter.
 * If no frontmatter is found, returns the entire string trimmed.
 */
export function extractBody(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  return match ? match[1].trim() : raw.trim();
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load all playbook markdown files from a directory.
 *
 * @param playbooksDir — optional override for the playbooks directory path.
 *   When omitted, resolves to `<package-root>/knowledge/playbooks/`.
 *   The override is used in tests to point at a temp directory.
 *
 * @returns readonly Playbook[] sorted alphabetically by filename.
 *   Returns empty array if the directory does not exist, contains no valid
 *   playbooks, or any filesystem error occurs. Never throws.
 */
export async function loadPlaybooks(playbooksDir?: string): Promise<readonly Playbook[]> {
  try {
    const dir = playbooksDir ?? join(findPackageRoot(__dirname), "knowledge", "playbooks");

    if (!existsSync(dir)) return [];

    const files = await readdir(dir);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort();

    const playbooks: Playbook[] = [];
    for (const file of mdFiles) {
      const raw = await readFile(join(dir, file), "utf-8");
      const frontmatter = parseFrontmatter(raw);
      if (!frontmatter) continue;

      playbooks.push({
        ...frontmatter,
        body: extractBody(raw),
        filename: file,
        id: file.replace(/\.md$/, ""),
        kind: "playbook",
      });
    }

    return playbooks;
  } catch {
    return [];
  }
}
