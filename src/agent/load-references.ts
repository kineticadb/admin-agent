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
 *   loadReferences(dir?)       — load the general references, returns readonly Reference[]
 *   loadBundleReferences(dir?) — load the bundle-scoped references (offline-mode only)
 *
 * Design:
 *   - Reuses parseFrontmatter(), extractBody(), findPackageRoot() from load-playbooks.ts
 *   - Returns empty array on any error (graceful degradation)
 *   - Never throws
 *   - Resolves references directory relative to package root
 *   - Bundle-scoped references live in the `bundle/` subdirectory and are loaded
 *     by a SEPARATE call (loadBundleReferences) so they reach only the offline
 *     bundle prompt and never bloat the live prompt. The general loader skips the
 *     subdirectory automatically (readdir's `.md` filter ignores the dir entry).
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Reference } from "../types/index.js";
import { parseFrontmatter, extractBody, findPackageRoot } from "./load-playbooks.js";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** Read + parse every *.md reference in a single directory. Never throws. */
async function loadReferencesFrom(dir: string): Promise<readonly Reference[]> {
  try {
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

/**
 * Load the general reference markdown files (live + bundle modes).
 *
 * @param refsDir — optional override for the references directory path.
 *   When omitted, resolves to `<package-root>/knowledge/references/`.
 *   The override is used in tests to point at a temp directory.
 *
 * @returns readonly Reference[] sorted alphabetically by filename. The `bundle/`
 *   subdirectory is NOT descended into (its entry isn't a `.md` file), so
 *   bundle-scoped references are excluded here. Never throws.
 */
export function loadReferences(refsDir?: string): Promise<readonly Reference[]> {
  return loadReferencesFrom(refsDir ?? join(findPackageRoot(__dirname), "knowledge", "references"));
}

/**
 * Load the bundle-scoped references — domain knowledge that only applies to
 * offline support-bundle analysis (bundle layout, log-line format, file parsing).
 * Kept on a separate load path so this content reaches only the bundle prompt.
 *
 * @param refsDir — optional override. When omitted, resolves to
 *   `<package-root>/knowledge/references/bundle/`.
 * @returns readonly Reference[] sorted alphabetically by filename. Never throws.
 */
export function loadBundleReferences(refsDir?: string): Promise<readonly Reference[]> {
  return loadReferencesFrom(
    refsDir ?? join(findPackageRoot(__dirname), "knowledge", "references", "bundle"),
  );
}
