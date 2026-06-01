/**
 * Tests for the playbook loader — parseFrontmatter, extractBody, and loadPlaybooks.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseFrontmatter, extractBody, loadPlaybooks } from "./load-playbooks.js";

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  it("parses valid frontmatter with all fields", () => {
    const raw = `---
title: GPU Out-of-Memory
category: performance
severity: critical
keywords: [VRAM, GPU, OOM]
---

## Symptoms
- GPU memory near 100%`;

    const result = parseFrontmatter(raw);
    expect(result).toEqual({
      title: "GPU Out-of-Memory",
      category: "performance",
      severity: "critical",
      keywords: ["VRAM", "GPU", "OOM"],
    });
  });

  it("returns null for content without frontmatter", () => {
    expect(parseFrontmatter("# Just a heading\nSome content")).toBeNull();
  });

  it("returns null when title is missing", () => {
    const raw = `---
category: performance
severity: critical
---

Content here`;

    expect(parseFrontmatter(raw)).toBeNull();
  });

  it("defaults category to 'general' and severity to 'info' when missing", () => {
    const raw = `---
title: Some Pattern
---

Content here`;

    const result = parseFrontmatter(raw);
    expect(result).toEqual({
      title: "Some Pattern",
      category: "general",
      severity: "info",
      keywords: [],
    });
  });

  it("handles empty keywords bracket", () => {
    const raw = `---
title: Test
keywords: []
---

Content`;

    expect(parseFrontmatter(raw)?.keywords).toEqual([]);
  });

  it("handles keywords without brackets (returns empty array)", () => {
    const raw = `---
title: Test
keywords: just a string
---

Content`;

    expect(parseFrontmatter(raw)?.keywords).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const raw = "---\r\ntitle: CRLF Test\r\ncategory: test\r\n---\r\n\r\nBody";

    const result = parseFrontmatter(raw);
    expect(result?.title).toBe("CRLF Test");
    expect(result?.category).toBe("test");
  });

  it("handles values containing colons", () => {
    const raw = `---
title: Error: Something Failed
category: errors
---

Content`;

    const result = parseFrontmatter(raw);
    expect(result?.title).toBe("Error: Something Failed");
  });
});

// ---------------------------------------------------------------------------
// extractBody
// ---------------------------------------------------------------------------

describe("extractBody", () => {
  it("extracts body after frontmatter", () => {
    const raw = `---
title: Test
---

## Symptoms
- Something broke`;

    expect(extractBody(raw)).toBe("## Symptoms\n- Something broke");
  });

  it("returns full content trimmed when no frontmatter", () => {
    expect(extractBody("  Just some text  ")).toBe("Just some text");
  });

  it("handles empty body after frontmatter", () => {
    const raw = `---
title: Empty
---
`;

    expect(extractBody(raw)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// loadPlaybooks
// ---------------------------------------------------------------------------

describe("loadPlaybooks", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "playbooks-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loads playbooks from directory", async () => {
    await writeFile(
      join(tmpDir, "test-pattern.md"),
      `---
title: Test Pattern
category: test
severity: info
keywords: [test]
---

## Symptoms
- Test symptom`,
    );

    const playbooks = await loadPlaybooks(tmpDir);
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0].title).toBe("Test Pattern");
    expect(playbooks[0].category).toBe("test");
    expect(playbooks[0].keywords).toEqual(["test"]);
    expect(playbooks[0].body).toContain("Test symptom");
    expect(playbooks[0].filename).toBe("test-pattern.md");
  });

  it("returns empty array for non-existent directory", async () => {
    const result = await loadPlaybooks("/nonexistent/path/to/playbooks");
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

    const playbooks = await loadPlaybooks(tmpDir);
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0].title).toBe("Valid");
  });

  it("skips non-markdown files", async () => {
    await writeFile(join(tmpDir, "notes.txt"), "not a playbook");
    await writeFile(
      join(tmpDir, "valid.md"),
      `---
title: Valid
---

Content`,
    );

    const playbooks = await loadPlaybooks(tmpDir);
    expect(playbooks).toHaveLength(1);
  });

  it("sorts playbooks alphabetically by filename", async () => {
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

    const playbooks = await loadPlaybooks(tmpDir);
    expect(playbooks).toHaveLength(2);
    expect(playbooks[0].filename).toBe("a-first.md");
    expect(playbooks[1].filename).toBe("b-second.md");
  });

  it("returns empty array for empty directory", async () => {
    const playbooks = await loadPlaybooks(tmpDir);
    expect(playbooks).toEqual([]);
  });
});
