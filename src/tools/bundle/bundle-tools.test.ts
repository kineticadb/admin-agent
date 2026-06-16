import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundleSource, type BundleSource } from "../../bundle/BundleSource.js";
import { bundleListFiles } from "./list-files.js";
import { bundleLogTimeline } from "./log-timeline.js";
import { bundleSearchLogs } from "./search-logs.js";
import { bundleReadConfig } from "./read-config.js";
import { bundleReadSysinfo } from "./read-sysinfo.js";
import { BUNDLE_TOOL_NAMES, makeBundleTools, createBundleRegistry } from "./index.js";
import { applyOutputPipeline } from "../index.js";
import { BUNDLE_TOOL_CATALOG, buildBundleEvidenceChecklist } from "./catalog.js";
import { bundleLoad } from "./load-bundle.js";
import { createBundleHolder } from "../../bundle/bundle-holder.js";

let dir: string;
let source: BundleSource;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bundle-tools-"));
  await mkdir(join(dir, "logs-local"), { recursive: true });
  await writeFile(
    join(dir, "gpudb_core_etc_gpudb.conf"),
    "[gaia]\nfile_version = 7.2.3.17\ntcs_per_tom = -1\n",
  );
  await writeFile(
    join(dir, "gpudb.txt"),
    "gpudb.txt\n----\nEXEC_CMD: gpudb -v\nGPUdb version    : 7.2.3.17.20260610181158\nEXEC_END with exit code 0 : ok\n",
  );
  await writeFile(
    join(dir, "mem.txt"),
    "mem.txt\n----\nEXEC_CMD: free -m -t\nMem: 7939 3023\nEXEC_END with exit code 0 : ok\n",
  );
  await writeFile(
    join(dir, "logs-local", "core-gpudb-rolling-r0.log"),
    [
      "2026-06-11 15:18:06.569 INFO  (1,1,r0/c) node2 App.cpp:1 - boot",
      "2026-06-11 15:18:52.786 FATAL (1,1,r0/c) node2 Job.cpp:9 - Segmentation fault, signal: 11",
      "2026-06-11 16:01:00.000 ERROR (1,1,r0/c) node2 Mem.cpp:2 - allocation failed",
    ].join("\n"),
  );
  source = await createBundleSource(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("bundleListFiles", () => {
  it("returns version, ranks, counts, and a file table", async () => {
    const r = await bundleListFiles(source);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.data as { detected_version: string; ranks_present: string; files: unknown[] };
      expect(d.detected_version).toBe("7.2.3.17.20260610181158");
      expect(d.ranks_present).toBe("r0");
      expect(Array.isArray(d.files)).toBe(true);
      // Every file row carries a one-line description for orientation.
      expect(
        d.files.every((f) => typeof (f as { description?: unknown }).description === "string"),
      ).toBe(true);
    }
  });

  it("filters the file list by kind", async () => {
    const r = await bundleListFiles(source, { kind: "config" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const files = (r.data as { files: { kind: string }[] }).files;
      expect(files.every((f) => f.kind === "config")).toBe(true);
    }
  });
});

describe("bundleLogTimeline", () => {
  it("buckets WARN+ events by hour with per-severity columns", async () => {
    const r = await bundleLogTimeline(source, { granularity: "hour" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const buckets = (r.data as { buckets: Record<string, unknown>[] }).buckets;
      expect(buckets).toHaveLength(2);
      expect(buckets[0]).toHaveProperty("time_bucket", "2026-06-11 15");
      expect(buckets[0]).toHaveProperty("FATAL", 1);
    }
  });
});

describe("bundleSearchLogs", () => {
  it("finds matches and reports the total", async () => {
    const r = await bundleSearchLogs(source, { regex: "Segmentation" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.data as { total_matched: number; matches: unknown[] };
      expect(d.total_matched).toBe(1);
      expect(d.matches).toHaveLength(1);
    }
  });

  it("notes when results are capped", async () => {
    const r = await bundleSearchLogs(source, { max_matches: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data as { capped: boolean }).capped).toBe(true);
      expect(r.note).toMatch(/capped/);
    }
  });
});

describe("bundle host-manager selection (tool wiring)", () => {
  let hmDir: string;
  let hmSource: BundleSource;

  beforeAll(async () => {
    hmDir = await mkdtemp(join(tmpdir(), "bundle-tools-hm-"));
    await mkdir(join(hmDir, "logs-local"), { recursive: true });
    await writeFile(
      join(hmDir, "logs-local", "core-gpudb-rolling-r0.log"),
      "2026-06-11 15:00:00.000 INFO (1,1,r0/c) node2 App.cpp:1 - boot\n",
    );
    await writeFile(
      join(hmDir, "logs-local", "core-gpudb-rolling-hm.log"),
      "2026-06-11 15:00:00.000 ERROR (1,1,hm/c) node2 Hm.cpp:1 - leader lost\n",
    );
    hmSource = await createBundleSource(hmDir);
  });

  afterAll(async () => {
    await rm(hmDir, { recursive: true, force: true });
  });

  it("search_logs host_manager:true returns the host-manager log lines", async () => {
    const r = await bundleSearchLogs(hmSource, { host_manager: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.data as { total_matched: number; files_scanned: string };
      expect(d.total_matched).toBe(1);
      expect(d.files_scanned).toContain("core-gpudb-rolling-hm.log");
    }
  });

  it("list_files reports the host manager under services_present, not ranks_present", async () => {
    const r = await bundleListFiles(hmSource);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = r.data as { ranks_present: string; services_present: string };
      expect(d.ranks_present).toBe("r0");
      expect(d.services_present).toContain("host-manager");
    }
  });
});

describe("bundleReadConfig", () => {
  it("returns matching entries", async () => {
    const r = await bundleReadConfig(source, { key: "tcs_per_tom" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual([{ section: "gaia", key: "tcs_per_tom", value: "-1" }]);
    }
  });

  it("surfaces available sections when a section filter matches nothing", async () => {
    const r = await bundleReadConfig(source, { section: "does-not-exist" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.note).toMatch(/No entries in section/);
      expect((r.data as { available_sections: string[] }).available_sections).toContain("gaia");
    }
  });
});

describe("bundleReadSysinfo", () => {
  it("returns command blocks for a known file", async () => {
    const r = await bundleReadSysinfo(source, { name: "mem.txt" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const blocks = (r.data as { blocks: { command: string }[] }).blocks;
      expect(blocks[0].command).toBe("free -m -t");
    }
  });

  it("returns a failure for an unknown file", async () => {
    const r = await bundleReadSysinfo(source, { name: "nope.txt" });
    expect(r.ok).toBe(false);
  });
});

describe("bundleLoad (kinetica_load_bundle)", () => {
  it("attaches a bundle into the holder and returns inventory", async () => {
    const holder = createBundleHolder();
    expect(holder.isLoaded()).toBe(false);

    const r = await bundleLoad(holder, { path: dir });
    expect(r.ok).toBe(true);
    expect(holder.isLoaded()).toBe(true);
    if (r.ok) {
      const d = r.data as Record<string, unknown>;
      expect(d.loaded).toBe(true);
      expect(d.detected_version).toBe("7.2.3.17.20260610181158");
    }
  });

  it("returns a failure for a path that is not a directory", async () => {
    const holder = createBundleHolder();
    const r = await bundleLoad(holder, { path: `${dir}/gpudb.txt` });
    expect(r.ok).toBe(false);
    expect(holder.isLoaded()).toBe(false);
  });

  it("invokes the directory picker when called without a path", async () => {
    const holder = createBundleHolder();
    const r = await bundleLoad(holder, {}, async () => dir); // stub picker returns the bundle dir
    expect(r.ok).toBe(true);
    expect(holder.isLoaded()).toBe(true);
  });

  it("fails when no path is given and no picker is available", async () => {
    const holder = createBundleHolder();
    const r = await bundleLoad(holder, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/No bundle path/);
  });

  it("fails gracefully when the picker is cancelled (returns undefined)", async () => {
    const holder = createBundleHolder();
    const r = await bundleLoad(holder, {}, async () => undefined);
    expect(r.ok).toBe(false);
    expect(holder.isLoaded()).toBe(false);
  });

  it("requires operator confirmation for a MODEL-supplied path and aborts when declined", async () => {
    // A model-chosen path widens the agent's file-read surface — the operator must consent.
    const holder = createBundleHolder();
    const confirmPath = vi.fn().mockResolvedValue(false);
    const r = await bundleLoad(holder, { path: dir }, undefined, confirmPath);
    expect(confirmPath).toHaveBeenCalledWith(dir);
    expect(r.ok).toBe(false);
    expect(holder.isLoaded()).toBe(false);
  });

  it("loads a model-supplied path once the operator confirms", async () => {
    const holder = createBundleHolder();
    const confirmPath = vi.fn().mockResolvedValue(true);
    const r = await bundleLoad(holder, { path: dir }, undefined, confirmPath);
    expect(confirmPath).toHaveBeenCalledWith(dir);
    expect(r.ok).toBe(true);
    expect(holder.isLoaded()).toBe(true);
  });

  it("does NOT re-confirm a path the operator chose via the picker", async () => {
    // No args.path → the picker IS the operator's choice; confirmPath must not fire.
    const holder = createBundleHolder();
    const confirmPath = vi.fn().mockResolvedValue(true);
    const r = await bundleLoad(holder, {}, async () => dir, confirmPath);
    expect(confirmPath).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(holder.isLoaded()).toBe(true);
  });
});

describe("barrel + catalog", () => {
  it("exposes exactly 6 bundle tools (5 readers + load_bundle)", () => {
    expect(BUNDLE_TOOL_NAMES).toHaveLength(6);
    expect(makeBundleTools(createBundleHolder(source))).toHaveLength(6);
  });

  it("has a catalog entry for every bundle tool name", () => {
    for (const name of BUNDLE_TOOL_NAMES) {
      expect(BUNDLE_TOOL_CATALOG[name]).toBeDefined();
    }
  });

  it("renders an evidence checklist containing every tool", () => {
    const checklist = buildBundleEvidenceChecklist();
    for (const name of BUNDLE_TOOL_NAMES) expect(checklist).toContain(name);
  });

  it("registers every bundle tool as read-only", () => {
    const registry = createBundleRegistry();
    for (const name of BUNDLE_TOOL_NAMES) expect(registry.isReadOnlyTool(name)).toBe(true);
  });
});

describe("applyOutputPipeline — note rendering", () => {
  it("prepends a success note so agent-facing guidance is not dropped", () => {
    const out = applyOutputPipeline({ ok: true, note: "results capped — narrow it", data: [] });
    expect(out).toContain("results capped — narrow it");
  });

  it("omits the note prefix when there is none", () => {
    const out = applyOutputPipeline({ ok: true, data: { a: 1 } });
    expect(out).not.toContain("undefined");
    expect(out).toContain("**a:** 1");
  });
});
