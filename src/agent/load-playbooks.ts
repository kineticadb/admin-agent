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
import type { Playbook } from "../types/index.js";

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

/** Parsed frontmatter fields from a playbook file. */
type FrontmatterFields = {
  readonly title: string;
  readonly category: string;
  readonly severity: string;
  readonly keywords: readonly string[];
};

/**
 * Parse YAML frontmatter from a markdown string.
 * Expects content starting with `---\n...\n---\n`.
 * Returns null if frontmatter is missing or the required `title` field is absent.
 *
 * Handles:
 * - Flat key: value pairs
 * - Bracket arrays: [item1, item2, item3]
 * - Both LF and CRLF line endings
 * - Defaults for optional fields (category → "general", severity → "info")
 */
export function parseFrontmatter(raw: string): FrontmatterFields | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return null;

  const yamlBlock = match[1];
  const fields: Record<string, string> = {};

  for (const line of yamlBlock.split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) fields[key] = value;
  }

  const title = fields.title;
  if (!title) return null;

  const keywordsRaw = fields.keywords ?? "";
  const keywords =
    keywordsRaw.startsWith("[") && keywordsRaw.endsWith("]")
      ? keywordsRaw
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  return {
    title,
    category: fields.category ?? "general",
    severity: fields.severity ?? "info",
    keywords,
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
      });
    }

    return playbooks;
  } catch {
    return [];
  }
}
