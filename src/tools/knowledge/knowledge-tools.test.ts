/**
 * Tests for the knowledge tool — kinetica_knowledge_read.
 */

import { describe, it, expect } from "vitest";

import { readKnowledge, renderKnowledgeResult } from "./read-knowledge.js";
import { KNOWLEDGE_TOOL_NAMES, makeKnowledgeTools, createKnowledgeRegistry } from "./index.js";
import { createKnowledgeStore } from "../../knowledge/KnowledgeStore.js";
import type { Playbook, Reference } from "../../types/index.js";

const gpudbConf: Reference = {
  title: "gpudb.conf Configuration Reference",
  category: "configuration",
  keywords: ["config"],
  summary: "Master config file.",
  readWhen: "Before interpreting any property.",
  body: "## Overview\n\nThe master file.\n\n## WAL\n\nWrite-ahead log details.",
  filename: "gpudb-conf.md",
  kind: "reference",
};

const memoryPressure: Playbook = {
  title: "Memory Pressure",
  category: "performance",
  severity: "warning",
  keywords: ["memory"],
  body: "## Symptoms\n\n- Slow queries\n\n## Remediation\n\nRaise the tier limit.",
  filename: "memory-pressure.md",
  kind: "playbook",
};

const store = createKnowledgeStore([memoryPressure, gpudbConf]);

describe("readKnowledge — whole document", () => {
  it("returns the body verbatim", () => {
    const result = readKnowledge(store, { id: "gpudb-conf" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe(gpudbConf.body);
  });

  it("notes the title, kind, size and section list", () => {
    const result = readKnowledge(store, { id: "gpudb-conf" });
    expect(result.ok && result.note).toContain("gpudb.conf Configuration Reference");
    expect(result.ok && result.note).toContain("reference");
    expect(result.ok && result.note).toMatch(/Sections:.*Overview.*WAL/);
  });

  it("resolves an id written with a '.md' suffix", () => {
    expect(readKnowledge(store, { id: "gpudb-conf.md" }).ok).toBe(true);
  });
});

describe("readKnowledge — one section", () => {
  it("returns only the requested section", () => {
    const result = readKnowledge(store, { id: "gpudb-conf", section: "wal" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBe("Write-ahead log details.");
  });

  it("names the section and the document's other sections in the note", () => {
    const result = readKnowledge(store, { id: "gpudb-conf", section: "wal" });
    expect(result.ok && result.note).toContain("WAL");
    expect(result.ok && result.note).toContain("Overview");
  });

  it("fails with the section list rather than returning the whole body", () => {
    const result = readKnowledge(store, { id: "gpudb-conf", section: "nonexistent" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("nonexistent");
      expect(result.error).toContain("Overview");
      expect(result.error).toContain("WAL");
      expect(result.error).not.toContain("Write-ahead log details");
    }
  });
});

describe("readKnowledge — unknown id", () => {
  it("lists every available id, grouped by kind", () => {
    const result = readKnowledge(store, { id: "does-not-exist" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("does-not-exist");
      expect(result.error).toContain("gpudb-conf");
      expect(result.error).toContain("memory-pressure");
      expect(result.error).toContain("playbook");
    }
  });

  it("reports an empty corpus without pretending ids exist", () => {
    const result = readKnowledge(createKnowledgeStore([]), { id: "anything" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no knowledge documents/i);
  });
});

describe("renderKnowledgeResult", () => {
  it("puts the note first, then the body", () => {
    const rendered = renderKnowledgeResult(readKnowledge(store, { id: "gpudb-conf" }));
    expect(rendered.indexOf("Sections:")).toBeLessThan(rendered.indexOf("## Overview"));
  });

  it("does NOT truncate the middle of a long document", () => {
    // truncateOutput keeps head 150 + tail 50 lines. gpudb-conf.md is already 165 lines,
    // so routing a document through the standard pipeline would delete its middle.
    const lines = Array.from({ length: 250 }, (_, i) => `line-${i}`);
    const long = createKnowledgeStore([
      { ...gpudbConf, filename: "long.md", body: `## All\n\n${lines.join("\n")}` },
    ]);
    const rendered = renderKnowledgeResult(readKnowledge(long, { id: "long" }));
    expect(rendered).toContain("line-160");
    expect(rendered).not.toContain("truncated");
  });

  it("renders a failure through the standard pipeline", () => {
    const rendered = renderKnowledgeResult(readKnowledge(store, { id: "nope" }));
    expect(rendered).toContain("nope");
  });
});

describe("knowledge tool registration", () => {
  it("exposes exactly one tool", () => {
    expect(KNOWLEDGE_TOOL_NAMES).toEqual(["kinetica_knowledge_read"]);
    expect(makeKnowledgeTools(store)).toHaveLength(1);
  });

  it("registers the tool as read-only", () => {
    expect(createKnowledgeRegistry().tools.has("kinetica_knowledge_read")).toBe(true);
  });

  it("annotates the tool read-only", () => {
    const [tool] = makeKnowledgeTools(store);
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("returns the document through the tool handler", async () => {
    const [tool] = makeKnowledgeTools(store);
    const out = await tool.handler({ id: "memory-pressure", section: undefined }, {});
    expect(out.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Raise the tier limit."),
    });
  });
});
