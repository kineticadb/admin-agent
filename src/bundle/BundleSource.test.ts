import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundleSource, type BundleSource } from "./BundleSource.js";

let dir: string;
let source: BundleSource;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bundle-src-"));
  await mkdir(join(dir, "logs-local"), { recursive: true });
  await mkdir(join(dir, "logs"), { recursive: true });

  await writeFile(
    join(dir, "gpudb_core_etc_gpudb.conf"),
    "[gaia]\nfile_version = 7.2.3.17\nuse_https = false\n",
  );
  await writeFile(
    join(dir, "gpudb.txt"),
    "gpudb.txt\n\n----\nEXEC_CMD: gpudb -v\nGPUdb version    : 7.2.3.17.20260610181158\nEXEC_END with exit code 0 : ok\n",
  );
  await writeFile(
    join(dir, "mem.txt"),
    "mem.txt\n\n----\nEXEC_CMD: free -m -t\nMem: 7939 3023\nEXEC_END with exit code 0 : ok\n",
  );
  await writeFile(
    join(dir, "errors.txt"),
    "FAILED gpu.txt : 127 : nvidia-smi\n---\nFAILED dmesg.txt : 1 : dmesg\n",
  );
  await writeFile(
    join(dir, "logs-local", "core-gpudb-rolling-r0.log"),
    [
      "2026-06-11 15:18:06.569 INFO  (1,1,r0/c) node2 App.cpp:1 - boot",
      "2026-06-11 15:18:07.000 ERROR (1,1,r0/c) node2 Gpu.cpp:3 - GPU OOM rank0",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "logs-local", "core-gpudb-rolling-r1.log"),
    "2026-06-11 16:00:00.000 ERROR (1,1,r1/c) node2 Shard.cpp:5 - shard failover rank1\n",
  );
  await writeFile(
    join(dir, "logs-local", "sql-engine.log"),
    "2026-06-11 15:18:03.000 WARN (1,1,sql) gpudb-sql-engine.sh slow query\n",
  );
  await writeFile(join(dir, "logs", "gpudb.log"), "loki tail snippet\n");

  source = await createBundleSource(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createBundleSource — inventory & version", () => {
  it("indexes all files", () => {
    const kinds = new Set(source.listFiles().map((e) => e.kind));
    expect(kinds).toContain("config");
    expect(kinds).toContain("core-log");
    expect(kinds).toContain("component-log");
    expect(kinds).toContain("loki-tail");
    expect(kinds).toContain("collection-errors");
  });

  it("detects the GPUdb version from gpudb.txt", async () => {
    expect(await source.detectVersion()).toBe("7.2.3.17.20260610181158");
  });
});

describe("readConfig", () => {
  it("returns config entries filtered by key", async () => {
    const r = await source.readConfig({ key: "version" });
    expect("entries" in r && r.entries).toEqual([
      { section: "gaia", key: "file_version", value: "7.2.3.17" },
    ]);
  });
});

describe("readSysinfo", () => {
  it("reads a named OS-diag file's EXEC_CMD blocks", async () => {
    const r = await source.readSysinfo("mem.txt");
    expect("blocks" in r && r.blocks[0].command).toBe("free -m -t");
    expect("blocks" in r && r.blocks[0].output).toBe("Mem: 7939 3023");
  });

  it("returns an error for an unknown file", async () => {
    const r = await source.readSysinfo("does-not-exist.txt");
    expect("error" in r).toBe(true);
  });
});

describe("searchLogs", () => {
  it("searches core logs across all ranks by default", async () => {
    const r = await source.searchLogs({ minSeverity: "ERROR" });
    expect(r.totalMatched).toBe(2);
    expect(r.filesScanned).toHaveLength(2);
    expect(r.matches.every((m) => m.file.includes("core-gpudb-rolling"))).toBe(true);
  });

  it("restricts the file set to a single rank", async () => {
    const r = await source.searchLogs({ rank: "r1" });
    expect(r.filesScanned).toEqual(["logs-local/core-gpudb-rolling-r1.log"]);
    expect(r.matches.every((m) => m.rank === "r1")).toBe(true);
  });

  it("searches a component log when component is given", async () => {
    const r = await source.searchLogs({ component: "sql-engine", regex: "slow" });
    expect(r.totalMatched).toBe(1);
    expect(r.matches[0].file).toBe("logs-local/sql-engine.log");
  });

  it("attaches the source file to every match", async () => {
    const r = await source.searchLogs({ regex: "OOM" });
    expect(r.matches[0].file).toBe("logs-local/core-gpudb-rolling-r0.log");
  });

  it("shares the match cap across files (per-search, not per-file)", async () => {
    // "rank" matches one ERROR line in each of the two core logs. With a cap of 1
    // the budget is shared: exactly one match returns and `capped` is set. Before
    // the fix each file applied its own cap, so this returned 2.
    const r = await source.searchLogs({ regex: "rank", maxMatches: 1 });
    expect(r.matches).toHaveLength(1);
    expect(r.capped).toBe(true);
  });

  it("widens a partial timestamp bound (timeline bucket label) to its full period", async () => {
    // to_ts as the hour bucket label must include the 15:18 lines, not exclude them.
    const r = await source.searchLogs({
      regex: "boot",
      fromTs: "2026-06-11 15",
      toTs: "2026-06-11 15",
    });
    expect(r.totalMatched).toBe(1);
    expect(r.matches[0].message).toContain("boot");
  });
});

describe("searchLogs — accurate totals under a display cap", () => {
  let mfDir: string;
  let mfSource: BundleSource;

  beforeAll(async () => {
    mfDir = await mkdtemp(join(tmpdir(), "bundle-mf-"));
    await mkdir(join(mfDir, "logs-local"), { recursive: true });
    await writeFile(
      join(mfDir, "logs-local", "core-gpudb-rolling-r0.log"),
      [
        "2026-06-11 15:00:00.000 ERROR (1,1,r0/c) node2 A.cpp:1 - boom one",
        "2026-06-11 15:00:01.000 ERROR (1,1,r0/c) node2 A.cpp:2 - boom two",
        "2026-06-11 15:00:02.000 ERROR (1,1,r0/c) node2 A.cpp:3 - boom three",
      ].join("\n"),
    );
    await writeFile(
      join(mfDir, "logs-local", "core-gpudb-rolling-r1.log"),
      [
        "2026-06-11 15:00:00.000 ERROR (1,1,r1/c) node2 B.cpp:1 - boom four",
        "2026-06-11 15:00:01.000 ERROR (1,1,r1/c) node2 B.cpp:2 - boom five",
      ].join("\n"),
    );
    mfSource = await createBundleSource(mfDir);
  });

  afterAll(async () => {
    await rm(mfDir, { recursive: true, force: true });
  });

  it("scans EVERY selected file for an accurate total even when the display cap is hit", async () => {
    // Cap of 2 with 3 matches in r0 + 2 in r1. The old loop broke after r0 filled the
    // budget, so totalMatched=3 and r1 was never scanned (incident looked r0-only).
    const r = await mfSource.searchLogs({ regex: "boom", maxMatches: 2 });
    expect(r.matches).toHaveLength(2); // display is capped …
    expect(r.totalMatched).toBe(5); // … but the TRUE total spans both files
    expect(r.linesScanned).toBe(5); // every line of both files was scanned
    expect(r.filesScanned).toHaveLength(2); // r1 not skipped
    expect(r.capped).toBe(true);
  });

  it("does NOT report capped when the cap is exactly met and later files add no matches", async () => {
    // r0 has exactly 2 matches for "one|two"; r1 has none. The old loop broke after
    // r0 filled the budget and set capped=true — a false "narrow your query" signal.
    const r = await mfSource.searchLogs({ regex: "one|two", maxMatches: 2 });
    expect(r.matches).toHaveLength(2);
    expect(r.totalMatched).toBe(2);
    expect(r.filesScanned).toHaveLength(2); // r1 still scanned to confirm nothing was dropped
    expect(r.capped).toBe(false);
  });
});

describe("inventory", () => {
  it("reports file/byte counts, kinds, and sorted ranks", () => {
    const inv = source.inventory();
    expect(inv.totalFiles).toBe(source.listFiles().length);
    expect(inv.byKind["core-log"]).toBe(2);
    expect(inv.ranks).toEqual(["r0", "r1"]);
    expect(inv.totalBytes).toBeGreaterThan(0);
  });
});

describe("searchLogs — loki-tail fallback", () => {
  let tailDir: string;
  let tailSource: BundleSource;

  beforeAll(async () => {
    tailDir = await mkdtemp(join(tmpdir(), "bundle-tail-"));
    await mkdir(join(tailDir, "logs"), { recursive: true });
    // Only a loki-tail log, no rolling core logs.
    await writeFile(
      join(tailDir, "logs", "gpudb.log"),
      "2026-06-11 15:18:09.000 ERROR (1,1,r0/c) node2 X.cpp:1 - tail-only error\n",
    );
    tailSource = await createBundleSource(tailDir);
  });

  afterAll(async () => {
    await rm(tailDir, { recursive: true, force: true });
  });

  it("falls back to loki-tail logs when no core logs are present", async () => {
    const r = await tailSource.searchLogs({ regex: "tail-only" });
    expect(r.filesScanned).toEqual(["logs/gpudb.log"]);
    expect(r.totalMatched).toBe(1);
  });
});

describe("host manager — a service, not a rank", () => {
  let hmDir: string;
  let hmSource: BundleSource;

  beforeAll(async () => {
    hmDir = await mkdtemp(join(tmpdir(), "bundle-hm-"));
    await mkdir(join(hmDir, "logs-local"), { recursive: true });
    await writeFile(
      join(hmDir, "logs-local", "core-gpudb-rolling-r0.log"),
      "2026-06-11 15:00:00.000 ERROR (1,1,r0/c) node2 App.cpp:1 - rank0 boom\n",
    );
    // The host-manager log's context carries no r\d+ token, so parseLogLine tags no
    // per-line rank — exactly the line the old rank:"hm" per-line filter silently dropped.
    await writeFile(
      join(hmDir, "logs-local", "core-gpudb-rolling-hm.log"),
      "2026-06-11 15:00:00.000 ERROR (1,1,hm/c) node2 Hm.cpp:1 - host manager leader lost\n",
    );
    hmSource = await createBundleSource(hmDir);
  });

  afterAll(async () => {
    await rm(hmDir, { recursive: true, force: true });
  });

  it("selects and RETURNS host-manager log lines via hostManager (regression: rank:'hm' returned nothing)", async () => {
    const r = await hmSource.searchLogs({ hostManager: true, minSeverity: "ERROR" });
    expect(r.filesScanned).toEqual(["logs-local/core-gpudb-rolling-hm.log"]);
    expect(r.totalMatched).toBe(1);
    expect(r.matches[0].message).toContain("leader lost");
  });

  it("excludes the host-manager log when filtering by a numeric rank", async () => {
    const r = await hmSource.searchLogs({ rank: "r0" });
    expect(r.filesScanned).toEqual(["logs-local/core-gpudb-rolling-r0.log"]);
    expect(r.totalMatched).toBe(1);
  });

  it("includes both rank and host-manager core logs in a default search", async () => {
    const r = await hmSource.searchLogs({ minSeverity: "ERROR" });
    expect(r.filesScanned).toHaveLength(2);
    expect(r.totalMatched).toBe(2);
  });

  it("buckets host-manager events in the timeline via hostManager", async () => {
    const r = await hmSource.logTimeline({ hostManager: true, minSeverity: "ERROR" });
    expect(r.filesScanned).toEqual(["logs-local/core-gpudb-rolling-hm.log"]);
    expect(r.totalCounted).toBe(1);
  });

  it("reports the host manager under services, never as a rank", () => {
    const inv = hmSource.inventory();
    expect(inv.services).toContain("host-manager");
    expect(inv.ranks).toEqual(["r0"]);
  });
});

describe("logTimeline", () => {
  it("merges per-rank buckets and sorts chronologically", async () => {
    const r = await source.logTimeline({ minSeverity: "WARN", granularity: "hour" });
    expect(r.buckets.map((b) => b.bucket)).toEqual(["2026-06-11 15", "2026-06-11 16"]);
    expect(r.totalCounted).toBe(2); // one ERROR per rank, both core logs
  });
});

describe("collectionErrors", () => {
  it("returns FAILED collection lines, skipping separators", async () => {
    const errors = await source.collectionErrors();
    expect(errors).toContain("FAILED gpu.txt : 127 : nvidia-smi");
    expect(errors).toContain("FAILED dmesg.txt : 1 : dmesg");
    expect(errors.some((e) => /^-+$/.test(e))).toBe(false);
  });
});

describe("resolve — path safety", () => {
  it("resolves a path inside the bundle root", () => {
    expect(source.resolve("mem.txt")).toBe(join(dir, "mem.txt"));
  });

  it("rejects a path that escapes the bundle root", () => {
    expect(source.resolve("../../etc/passwd")).toBeUndefined();
  });
});
