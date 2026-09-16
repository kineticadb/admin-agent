/**
 * Tests for the KnowledgeStore — id resolution, section lookup, disclosure partition.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { createKnowledgeStore } from "./KnowledgeStore.js";
import { MAX_DOC_TOKENS } from "./normalize-doc.js";
import type { Playbook, Reference } from "../types/index.js";

const ref = (over: Partial<Reference> = {}): Reference => ({
  title: "Service Management",
  category: "operations",
  keywords: ["systemctl"],
  body: "## Scope\n\nWhat this covers.\n\n## Reporting Rules\n\nHow to report.",
  filename: "service-management.md",
  ...over,
});

const pb = (over: Partial<Playbook> = {}): Playbook => ({
  ...ref({ filename: "memory-pressure.md", title: "Memory Pressure" }),
  severity: "warning",
  body: "## Symptoms\n\n- Slow queries\n\n## Detection\n\nCheck tiers.",
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createKnowledgeStore", () => {
  it("normalizes every document it is given", () => {
    const store = createKnowledgeStore([ref(), pb()]);
    expect(store.list().map((d) => d.id)).toEqual(["service-management", "memory-pressure"]);
    expect(store.list().every((d) => d.disclosure === "on-demand")).toBe(true);
  });

  it("returns an empty store for no documents", () => {
    const store = createKnowledgeStore([]);
    expect(store.list()).toEqual([]);
    expect(store.inline()).toEqual([]);
    expect(store.onDemand()).toEqual([]);
  });

  // -- id resolution --------------------------------------------------------

  it("resolves a document by its id", () => {
    expect(createKnowledgeStore([ref()]).get("service-management")?.title).toBe(
      "Service Management",
    );
  });

  it("tolerates a '.md' suffix, so cross-references inside documents keep working", () => {
    expect(createKnowledgeStore([ref()]).get("service-management.md")?.id).toBe(
      "service-management",
    );
  });

  it("resolves case-insensitively and ignores surrounding whitespace", () => {
    expect(createKnowledgeStore([ref()]).get("  Service-Management  ")?.id).toBe(
      "service-management",
    );
  });

  it("returns undefined for an unknown id", () => {
    expect(createKnowledgeStore([ref()]).get("nope")).toBeUndefined();
  });

  // -- section lookup -------------------------------------------------------

  it("matches a section by case-insensitive substring of its heading", () => {
    const store = createKnowledgeStore([ref()]);
    expect(store.getSection("service-management", "reporting")?.heading).toBe("Reporting Rules");
  });

  it("returns undefined when no section matches", () => {
    expect(createKnowledgeStore([ref()]).getSection("service-management", "zzz")).toBeUndefined();
  });

  it("returns undefined when the document itself is unknown", () => {
    expect(createKnowledgeStore([ref()]).getSection("nope", "scope")).toBeUndefined();
  });

  it("prefers an exact heading match over a longer substring match", () => {
    const store = createKnowledgeStore([ref({ body: "## Rules\n\nA\n\n## Reporting Rules\n\nB" })]);
    expect(store.getSection("service-management", "Rules")?.body).toBe("A");
  });

  // -- disclosure partition -------------------------------------------------

  it("partitions documents by disclosure", () => {
    const store = createKnowledgeStore([
      ref({ filename: "mutation-safety.md", disclosure: "inline" }),
      ref({ filename: "sql-dialect.md" }),
      pb(),
    ]);
    expect(store.inline().map((d) => d.id)).toEqual(["mutation-safety"]);
    expect(store.onDemand().map((d) => d.id)).toEqual(["sql-dialect", "memory-pressure"]);
  });

  // -- oversize warning -----------------------------------------------------

  it("warns once on stderr for a document above MAX_DOC_TOKENS", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    createKnowledgeStore([ref({ body: "x".repeat((MAX_DOC_TOKENS + 100) * 4) })]);
    const warnings = write.mock.calls.filter((c) => String(c[0]).includes("service-management"));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toMatch(/section/);
  });

  it("does not warn for a document within MAX_DOC_TOKENS", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    createKnowledgeStore([ref()]);
    expect(write).not.toHaveBeenCalled();
  });
});
