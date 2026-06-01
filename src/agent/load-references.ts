/**
 * Reference loader — reads domain knowledge from knowledge/references/*.md.
 *
 * Each reference is a Markdown file with YAML frontmatter (title, category, keywords)
 * and a body containing structured reference material (section indexes, parameter
 * guides, gotchas, etc.).
 *
 * Unlike playbooks (which are diagnostic runbooks with severity), references are
 * informational documents that give the agent domain knowledge about Kinetica
 * internals (e.g., gpudb.conf structure, tier storage semantics).
 *
 * Exports:
 *   loadReferences(dir?) — load all references from directory, returns readonly Reference[]
 *
 * Design:
 *   - Reuses parseFrontmatter(), extractBody(), findPackageRoot() from load-playbooks.ts
 *   - Returns empty array on any error (graceful degradation)
 *   - Never throws
 *   - Resolves references directory relative to package root
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Reference } from "../types/index.js";
import { parseFrontmatter, extractBody, findPackageRoot } from "./load-playbooks.js";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load all reference markdown files from a directory.
 *
 * @param refsDir — optional override for the references directory path.
 *   When omitted, resolves to `<package-root>/knowledge/references/`.
 *   The override is used in tests to point at a temp directory.
 *
 * @returns readonly Reference[] sorted alphabetically by filename.
 *   Returns empty array if the directory does not exist, contains no valid
 *   references, or any filesystem error occurs. Never throws.
 */
export async function loadReferences(refsDir?: string): Promise<readonly Reference[]> {
  try {
    const dir = refsDir ?? join(findPackageRoot(__dirname), "knowledge", "references");

    if (!existsSync(dir)) return [];

    const files = await readdir(dir);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort();

    const references: Reference[] = [];
    for (const file of mdFiles) {
      const raw = await readFile(join(dir, file), "utf-8");
      const frontmatter = parseFrontmatter(raw);
      if (!frontmatter) continue;

      references.push({
        title: frontmatter.title,
        category: frontmatter.category,
        keywords: frontmatter.keywords,
        body: extractBody(raw),
        filename: file,
      });
    }

    return references;
  } catch {
    return [];
  }
}
