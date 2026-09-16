/**
 * Corpus lint — the one test that reads the REAL knowledge/ tree.
 *
 * Everything else in this repo tests behaviour against synthetic fixtures. This file
 * exists because the corpus is authored markdown that no compiler checks: the fields
 * the prompt's cards render live in frontmatter, and cross-references between documents
 * are prose. Both drift silently.
 *
 * It is the standing guard for a bug that survived months unnoticed: Prettier reflows a
 * `keywords:` array wider than printWidth onto several lines, which the line-oriented
 * frontmatter parser read as empty — 7 of 12 references loaded with zero keywords, and
 * nothing failed, because nothing consumed keywords yet.
 *
 * Keep the assertions structural and cheap. Content lives in the documents.
 */

import { describe, it, expect, beforeAll } from "vitest";

import { loadPlaybooks } from "../agent/load-playbooks.js";
import { loadReferences, loadBundleReferences } from "../agent/load-references.js";
import { createKnowledgeStore, type KnowledgeStore } from "./KnowledgeStore.js";
import { MAX_DOC_TOKENS } from "./normalize-doc.js";
import type { Playbook, Reference } from "../types/index.js";

/** Authored limits — a card row must stay readable in a markdown table. */
const SUMMARY_MAX = 220;
const READ_WHEN_MAX = 160;

let playbooks: readonly Playbook[];
let references: readonly Reference[];
let bundleReferences: readonly Reference[];
let raw: readonly (Playbook | Reference)[];
let store: KnowledgeStore;

beforeAll(async () => {
  [playbooks, references, bundleReferences] = await Promise.all([
    loadPlaybooks(),
    loadReferences(),
    loadBundleReferences(),
  ]);
  raw = [...playbooks, ...references, ...bundleReferences];
  store = createKnowledgeStore(raw);
});

describe("knowledge corpus", () => {
  it("loads every document in the tree", () => {
    expect(playbooks.length).toBeGreaterThan(0);
    expect(references.length).toBeGreaterThan(0);
    expect(bundleReferences.length).toBeGreaterThan(0);
  });

  it("gives every document at least one keyword", () => {
    // Guards the Prettier-reflow parser bug forever. A zero here means either a
    // frontmatter array the parser can no longer read, or an unkeyworded new document.
    const unkeyworded = raw.filter((d) => d.keywords.length === 0).map((d) => d.filename);
    expect(unkeyworded).toEqual([]);
  });

  it("gives every document a unique id", () => {
    const ids = store.list().map((d) => d.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it("tags every document with the kind its directory implies", () => {
    expect(playbooks.every((p) => p.kind === "playbook")).toBe(true);
    expect(references.every((r) => r.kind === "reference")).toBe(true);
    expect(bundleReferences.every((r) => r.kind === "bundle-reference")).toBe(true);
  });
});

describe("knowledge corpus — card metadata", () => {
  /** References rendered as cards must carry BOTH authored fields — see below. */
  const onDemandReferences = (): readonly Reference[] =>
    [...references, ...bundleReferences].filter((r) => r.disclosure !== "inline");

  it("gives every on-demand reference an authored summary within the limit", () => {
    // Derivation from "## Overview" is a fixture fallback, not a corpus strategy: a
    // card is the ONLY thing the agent sees for an on-demand document, so its wording
    // is a deliberate authoring decision.
    for (const ref of onDemandReferences()) {
      expect(ref.summary, `${ref.filename} is missing a summary`).toBeTruthy();
      expect(ref.summary!.length, `${ref.filename} summary is too long`).toBeLessThanOrEqual(
        SUMMARY_MAX,
      );
    }
  });

  it("gives every on-demand reference an unconditional read_when trigger", () => {
    for (const ref of onDemandReferences()) {
      expect(ref.readWhen, `${ref.filename} is missing read_when`).toBeTruthy();
      expect(ref.readWhen!.length, `${ref.filename} read_when is too long`).toBeLessThanOrEqual(
        READ_WHEN_MAX,
      );
    }
  });

  it("phrases every read_when as a trigger, not as a topical hint", () => {
    // This repo has measured the failure: a capability described conditionally is a
    // capability the agent will not use. "If you need X" is permission to skip.
    for (const ref of onDemandReferences()) {
      expect(ref.readWhen, `${ref.filename} read_when reads as optional`).not.toMatch(
        /^\s*(if you|when you need|useful|for more|optionally)/i,
      );
    }
  });

  it("gives every playbook a Symptoms section, because that IS its card", () => {
    for (const doc of store.list().filter((d) => d.kind === "playbook")) {
      const headings = doc.sections.map((s) => s.heading.toLowerCase());
      expect(headings, `${doc.filename} has no ## Symptoms`).toContain("symptoms");
      expect(doc.summary, `${doc.filename} derived an empty summary`).toBeTruthy();
    }
  });
});

describe("knowledge corpus — integrity", () => {
  it("keeps every document within MAX_DOC_TOKENS", () => {
    const oversize = store
      .list()
      .filter((d) => d.tokens > MAX_DOC_TOKENS)
      .map((d) => `${d.id} (~${d.tokens})`);
    expect(oversize).toEqual([]);
  });

  it("resolves every <name>.md cross-reference inside a document body", () => {
    // Bodies point at each other in prose ("see service-management.md"). Once bodies
    // leave the prompt those become read instructions, so a dangling one sends the
    // agent after a document that does not exist.
    const dangling = store.list().flatMap((doc) =>
      [...doc.body.matchAll(/\b([A-Za-z0-9_.-]+\.md)\b/g)]
        .map((m) => m[1])
        .filter((name) => !store.get(name))
        .map((name) => `${doc.filename} → ${name}`),
    );
    expect([...new Set(dangling)]).toEqual([]);
  });

  it("splits every document into at least one section", () => {
    const sectionless = store.list().filter((d) => d.sections.length === 0);
    expect(sectionless).toEqual([]);
  });
});

describe("knowledge corpus — the rules each document must still carry", () => {
  /**
   * These assertions moved here from system-prompt.test.ts when the corpus went
   * progressive-disclosure. They always verified that the real documents on disk
   * still carry their hard-won rules; asserting that through the rendered prompt
   * only worked while every body was inlined, and would now silently pass or fail
   * on whether a phrase happened to appear in a card summary instead.
   *
   * The prompt's own job — that each document is advertised with its trigger — is
   * asserted in system-prompt.test.ts. This file asserts the documents' content.
   */
  const body = (id: string): string => {
    const doc = store.get(id);
    expect(doc, `missing document: ${id}`).toBeDefined();
    return doc!.body;
  };

  it("sql-alter-table keeps the 7.2 column-property grammar", () => {
    const text = body("sql-alter-table");
    expect(text).toContain("ALTER TABLE");
    expect(text).toContain("ALTER COLUMN");
    expect(text).toContain("MODIFY COLUMN");
    expect(text).toContain("VARCHAR(size, DICT)");
    expect(text).toContain("TEXT_SEARCH");
    expect(text).toContain("COMPRESS");
    expect(text).toMatch(/dependent.{0,30}(views|materialized)/i);
  });

  it("sql-create-index keeps the index-name-before-ON rule", () => {
    const text = body("sql-create-index");
    expect(text).toContain("CREATE INDEX index_name ON");
    expect(text).toMatch(/index name.{0,30}REQUIRED/i);
  });

  it("sql-dialect keeps the PostgreSQL baseline and the false friends", () => {
    const text = body("sql-dialect");
    expect(text).toContain("PostgreSQL-compatible");
    expect(text).toContain("TRY_CAST");
    expect(text).toContain("SAFE_CAST");
    expect(text).toContain("DATEDIFF");
  });

  it("service-management keeps the sanctioned commands and the never-emit table", () => {
    const text = body("service-management");
    expect(text).toContain("systemctl start gpudb_host_manager");
    expect(text).toContain("/opt/gpudb/core/bin/gpudb");
    expect(text).toContain("There Is No Per-Rank Restart");
    expect(text).toContain("WRONG — Never Emit These");
    expect(text).toContain("`gadmin` is not a service-control CLI");
  });

  it("catalog-joins keeps the ki_tiered_objects.id warning", () => {
    const text = body("catalog-joins");
    expect(text).toMatch(/ki_tiered_objects\.id.*NOT.*numeric.*OID/is);
    expect(text).toMatch(/kinetica_resource_objects.*table_names/is);
  });

  it("rank-architecture keeps the rank 0 asymmetry warning", () => {
    const text = body("rank-architecture");
    expect(text).toMatch(/rank 0.*(head|coordinator)/is);
    expect(text).toMatch(/rank 0.*low.*(usage|idle).*normal/is);
  });

  it("mutation-safety stays inline — it is policy the agent cannot know to look up", () => {
    const doc = store.get("mutation-safety");
    expect(doc?.disclosure).toBe("inline");
    expect(doc?.body).toContain("/clear/table");
    expect(doc?.body).toContain("ai_api_key");
  });

  it("mutation-safety orders the service-management read instead of answering it", () => {
    // An inline copy of the sanctioned commands SATISFIES the agent's need, so the
    // MANDATORY read never fires — the inline document ends up competing with the card it
    // is supposed to point at. Measured 2026-09-16: the agent emitted `systemctl stop
    // gpudb` / `systemctl start gpudb` verbatim from this file, read 4 documents, and
    // `service-management` was not among them — while a later step still told the operator
    // to "edit gpudb.conf directly and restart", the bare form this corpus forbids. Three
    // explicit prompt hooks had already failed to pull the read; removing the answer is
    // what leaves the read as the only path to it.
    const text = body("mutation-safety");
    expect(text).not.toContain("systemctl");
    // \s+ because the corpus is hard-wrapped: this phrase spans a line break at both sites.
    expect(text).toMatch(/read\s+`service-management`\s+with\s+`kinetica_knowledge_read`/i);
  });
});
