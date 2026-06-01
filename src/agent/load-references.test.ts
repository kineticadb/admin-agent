/**
 * Tests for the reference loader — loadReferences.
 *
 * Follows the same test patterns as load-playbooks.test.ts:
 * - Temp directory for filesystem tests
 * - Frontmatter parsing reused from load-playbooks (tested there)
 * - Focus on reference-specific behavior (no severity field)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadReferences } from "./load-references.js";

// ---------------------------------------------------------------------------
// loadReferences
// ---------------------------------------------------------------------------

describe("loadReferences", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "references-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads references from directory", async () => {
    await writeFile(
      join(tmpDir, "test-ref.md"),
      `---
title: Test Reference
category: configuration
keywords: [config, test]
---

## Section Index
- Section A: Does thing A`,
    );

    const refs = await loadReferences(tmpDir);
    expect(refs).toHaveLength(1);
    expect(refs[0].title).toBe("Test Reference");
    expect(refs[0].category).toBe("configuration");
    expect(refs[0].keywords).toEqual(["config", "test"]);
    expect(refs[0].body).toContain("Section Index");
    expect(refs[0].filename).toBe("test-ref.md");
  });

  it("does not include severity field on returned references", async () => {
    await writeFile(
      join(tmpDir, "no-severity.md"),
      `---
title: No Severity
severity: critical
---

Content`,
    );

    const refs = await loadReferences(tmpDir);
    expect(refs).toHaveLength(1);

    expect((refs[0] as any).severity).toBeUndefined();
  });

  it("returns empty array for non-existent directory", async () => {
    const result = await loadReferences("/nonexistent/path/to/references");
    expect(result).toEqual([]);
  });

  it("skips files without valid frontmatter", async () => {
    await writeFile(
      join(tmpDir, "valid.md"),
      `---
title: Valid
---

Content`,
    );
    await writeFile(join(tmpDir, "invalid.md"), "# No frontmatter\nContent");

    const refs = await loadReferences(tmpDir);
    expect(refs).toHaveLength(1);
    expect(refs[0].title).toBe("Valid");
  });

  it("skips non-markdown files", async () => {
    await writeFile(join(tmpDir, "notes.txt"), "not a reference");
    await writeFile(
      join(tmpDir, "valid.md"),
      `---
title: Valid
---

Content`,
    );

    const refs = await loadReferences(tmpDir);
    expect(refs).toHaveLength(1);
  });

  it("sorts references alphabetically by filename", async () => {
    await writeFile(
      join(tmpDir, "b-second.md"),
      `---
title: Second
---

B`,
    );
    await writeFile(
      join(tmpDir, "a-first.md"),
      `---
title: First
---

A`,
    );

    const refs = await loadReferences(tmpDir);
    expect(refs).toHaveLength(2);
    expect(refs[0].filename).toBe("a-first.md");
    expect(refs[1].filename).toBe("b-second.md");
  });

  it("returns empty array for empty directory", async () => {
    const refs = await loadReferences(tmpDir);
    expect(refs).toEqual([]);
  });

  it("loads from default knowledge/references/ directory when no arg given", async () => {
    // This test verifies the default path resolution works without errors.
    // It may find 0 or more references depending on what's in knowledge/references/.
    const refs = await loadReferences();
    expect(Array.isArray(refs)).toBe(true);
  });
});
