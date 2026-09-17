/**
 * Tests for the eval run artifact.
 *
 * Covers the filename shape (outcome included, so a directory listing tells the story),
 * the self-describing frontmatter, credential scrubbing, that a scenario id cannot escape
 * reports/, and — the load-bearing ones — that a failed write degrades instead of throwing,
 * and that the fallback differs by outcome. A dump that threw would turn an assertion
 * failure (exit 1) into a harness failure (exit 2), collapsing the distinction this harness
 * cost four live runs to learn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:fs/promises to avoid real file I/O, as save-report.test.ts does.
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import * as fsPromises from "node:fs/promises";

import { dumpEvalReport, preserveRunArtifact, buildRunFrontmatter } from "./dump-report.js";

const AT = new Date("2026-09-15T14:30:45.000Z");
const PASS = { outcome: "PASS" } as const;
const FAIL = { outcome: "FAIL" } as const;

/** The bytes handed to writeFile. Narrowed rather than stringified: the data param is a
 *  union, and a non-string here means the module changed shape, which should fail loudly. */
const written = (): string => {
  const data = vi.mocked(fsPromises.writeFile).mock.calls[0]?.[1];
  return typeof data === "string" ? data : "";
};

describe("buildRunFrontmatter", () => {
  it("records the run in strippable `---` frontmatter", () => {
    const fm = buildRunFrontmatter(
      "memory-pressure",
      {
        outcome: "PASS",
        turns: 35,
        costUsd: 0.7677,
        toolCalls: 33,
        knowledgeReads: ["memory-pressure", "service-management"],
      },
      AT,
    );
    expect(fm).toContain("scenario: memory-pressure");
    expect(fm).toContain("outcome: PASS");
    expect(fm).toContain("run_at: 2026-09-15T14:30:45.000Z");
    expect(fm).toContain("turns: 35");
    expect(fm).toContain("cost_usd: 0.7677");
    expect(fm).toContain("tool_calls: 33");
    expect(fm).toContain("knowledge_reads: [memory-pressure, service-management]");
    expect(fm.startsWith("---\n")).toBe(true);
    expect(fm.trimEnd().endsWith("---")).toBe(true);
  });

  it("records an EMPTY read list — reading nothing is the finding, not an absence", () => {
    const fm = buildRunFrontmatter("x", { outcome: "FAIL", knowledgeReads: [] }, AT);
    expect(fm).toContain("knowledge_reads: []");
  });

  it("records whether the save was confirmed through the widget", () => {
    expect(buildRunFrontmatter("x", { outcome: "PASS", askedFirst: true }, AT)).toContain(
      "asked_first: true",
    );
  });

  it("records a skipped ask as false rather than omitting it", () => {
    // false is the finding this field exists to surface -- a green run whose consent
    // widget never fired. Dropping it would make the artifact silent on exactly that.
    expect(buildRunFrontmatter("x", { outcome: "PASS", askedFirst: false }, AT)).toContain(
      "asked_first: false",
    );
  });

  it("omits fields the caller did not supply", () => {
    const fm = buildRunFrontmatter("x", PASS, AT);
    expect(fm).not.toContain("turns:");
    expect(fm).not.toContain("cost_usd:");
    expect(fm).not.toContain("knowledge_reads:");
    expect(fm).not.toContain("asked_first:");
  });
});

describe("dumpEvalReport", () => {
  beforeEach(() => {
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("names the file with the outcome, so a listing needs no opening", async () => {
    await expect(dumpEvalReport("stale-rank", "# R", PASS, AT)).resolves.toMatch(
      /reports[/\\]eval-stale-rank-pass-2026-09-15-143045\.md$/,
    );
    vi.clearAllMocks();
    await expect(dumpEvalReport("stale-rank", "# R", FAIL, AT)).resolves.toMatch(
      /reports[/\\]eval-stale-rank-fail-2026-09-15-143045\.md$/,
    );
  });

  it("creates reports/ and writes frontmatter above the report", async () => {
    await dumpEvalReport("memory-pressure", "# Kinetica Diagnostic Report", PASS, AT);
    expect(fsPromises.mkdir).toHaveBeenCalledWith(expect.stringContaining("reports"), {
      recursive: true,
    });
    expect(written().indexOf("---")).toBeLessThan(written().indexOf("# Kinetica"));
  });

  it("scrubs credentials in the report", async () => {
    await dumpEvalReport("memory-pressure", "Connected to http://admin:hunter2@db:9191", PASS, AT);
    expect(written()).toContain("[REDACTED]");
    expect(written()).not.toContain("hunter2");
  });

  it("leaves the frontmatter intact while scrubbing the report", async () => {
    await dumpEvalReport("memory-pressure", "see http://db:9191", { ...PASS, turns: 35 }, AT);
    expect(written()).toContain("turns: 35");
    expect(written()).toContain("scenario: memory-pressure");
  });

  it("cannot be steered out of reports/ by the scenario id", async () => {
    await expect(dumpEvalReport("../../etc/passwd", "# R", FAIL, AT)).resolves.toMatch(
      /reports[/\\]eval-------etc-passwd-fail-2026-09-15-143045\.md$/,
    );
  });

  it("returns undefined instead of throwing when the write fails", async () => {
    vi.mocked(fsPromises.writeFile).mockRejectedValue(new Error("EROFS: read-only file system"));
    await expect(dumpEvalReport("stale-rank", "# R", FAIL, AT)).resolves.toBeUndefined();
  });

  it("returns undefined instead of throwing when the directory cannot be created", async () => {
    vi.mocked(fsPromises.mkdir).mockRejectedValue(new Error("EACCES"));
    await expect(dumpEvalReport("stale-rank", "# R", PASS, AT)).resolves.toBeUndefined();
  });
});

describe("preserveRunArtifact", () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
    stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    stderr.mockRestore();
    vi.clearAllMocks();
  });

  const out = (): string => stderr.mock.calls.flat().join("\n");

  it("announces the path and never prints the body when the write succeeds", async () => {
    await preserveRunArtifact("[eval:x]", "stale-rank", "BODY-MARKER", PASS);
    expect(out()).toMatch(/PASS report written to .*eval-stale-rank-pass-/);
    expect(out()).not.toContain("BODY-MARKER");
  });

  it("prints a FAILING report's body when the write fails — the evidence must survive", async () => {
    vi.mocked(fsPromises.writeFile).mockRejectedValue(new Error("EROFS"));
    await preserveRunArtifact("[eval:x]", "stale-rank", "BODY-MARKER", FAIL);
    expect(out()).toContain("Could not write the captured report");
    expect(out()).toContain("BODY-MARKER");
  });

  it("does NOT print a PASSING report's body when the write fails", async () => {
    // A wall of text on every green run is how the stderr copy stopped being read.
    vi.mocked(fsPromises.writeFile).mockRejectedValue(new Error("EROFS"));
    await preserveRunArtifact("[eval:x]", "stale-rank", "BODY-MARKER", PASS);
    expect(out()).toContain("Could not write the captured report");
    expect(out()).not.toContain("BODY-MARKER");
  });
});
