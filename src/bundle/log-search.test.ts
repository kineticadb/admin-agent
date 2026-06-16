import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  searchLogFile,
  aggregateTimeline,
  floorTimestamp,
  ceilTimestamp,
  DEFAULT_MAX_MATCHES,
  REGEX_SCAN_MAX,
} from "./log-search.js";

const LINES = [
  "2026-06-11 15:18:06.569 INFO  (1,1,r0/ctx) node2 App.cpp:1 - boot rank0",
  "2026-06-11 15:18:07.000 WARN  (1,1,r0/ctx) node2 Mem.cpp:9 - memory high",
  "2026-06-11 15:18:08.000 ERROR (1,1,r0/ctx) node2 Gpu.cpp:3 - GPU OOM",
  "2026-06-11 16:02:00.000 ERROR (1,1,r1/ctx) node2 Shard.cpp:5 - shard failover",
  "2026-06-11 16:05:00.000 INFO  (1,1,r1/ctx) node2 App.cpp:1 - recovered",
  "    continuation line with no timestamp",
];

let dir: string;
let logPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bundle-log-"));
  logPath = join(dir, "core-gpudb-rolling-r0.log");
  await writeFile(logPath, LINES.join("\n"), "utf-8");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("searchLogFile", () => {
  it("matches by case-insensitive regex against the raw line", async () => {
    const r = await searchLogFile(logPath, { regex: "oom" });
    expect(r.totalMatched).toBe(1);
    expect(r.matches[0].message).toBe("GPU OOM");
    expect(r.matches[0].lineNumber).toBe(3);
  });

  it("filters by minimum severity", async () => {
    const r = await searchLogFile(logPath, { minSeverity: "ERROR" });
    expect(r.totalMatched).toBe(2);
    expect(r.matches.every((m) => m.severity === "ERROR")).toBe(true);
  });

  it("filters by rank", async () => {
    const r = await searchLogFile(logPath, { rank: "r1" });
    expect(r.totalMatched).toBe(2);
    expect(r.matches.every((m) => m.rank === "r1")).toBe(true);
  });

  it("filters by inclusive timestamp range (lexical)", async () => {
    const r = await searchLogFile(logPath, {
      fromTs: "2026-06-11 16:00:00.000",
      toTs: "2026-06-11 16:59:59.999",
    });
    expect(r.totalMatched).toBe(2);
  });

  it("scans every line including the unparseable continuation line", async () => {
    const r = await searchLogFile(logPath, {});
    expect(r.linesScanned).toBe(LINES.length);
    expect(r.totalMatched).toBe(LINES.length);
  });

  it("caps returned matches while still counting the true total", async () => {
    const r = await searchLogFile(logPath, { maxMatches: 2 });
    expect(r.matches).toHaveLength(2);
    expect(r.totalMatched).toBe(LINES.length);
    expect(r.capped).toBe(true);
  });

  it("returns an error result for an invalid regex (never throws)", async () => {
    const r = await searchLogFile(logPath, { regex: "(" });
    expect(r.error).toMatch(/invalid regex/);
  });

  it("returns an error result for a missing file (never throws)", async () => {
    const r = await searchLogFile(join(dir, "nope.log"), {});
    expect(r.error).toBeDefined();
    expect(r.totalMatched).toBe(0);
  });

  it("defaults maxMatches to DEFAULT_MAX_MATCHES", async () => {
    const r = await searchLogFile(logPath, {});
    expect(r.matches.length).toBeLessThanOrEqual(DEFAULT_MAX_MATCHES);
  });

  it("only tests the regex within the bounded scan window (ReDoS defense-in-depth)", async () => {
    // A line longer than the scan cap, with the search token sitting only PAST
    // the cap. The regex is tested against a bounded prefix, so the unbounded
    // input dimension that drives catastrophic backtracking is removed.
    const d = await mkdtemp(join(tmpdir(), "bundle-redos-"));
    const p = join(d, "big.log");
    const line = "x".repeat(REGEX_SCAN_MAX + 100) + "NEEDLE";
    await writeFile(p, line + "\n", "utf-8");
    try {
      // Token beyond the window is not matched...
      const beyond = await searchLogFile(p, { regex: "NEEDLE" });
      expect(beyond.totalMatched).toBe(0);
      // ...but a token inside the window still matches.
      const inside = await searchLogFile(p, { regex: "x" });
      expect(inside.totalMatched).toBe(1);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe("floorTimestamp / ceilTimestamp", () => {
  it("widens an hour bucket label to the start and end of the hour", () => {
    expect(floorTimestamp("2026-06-11 15")).toBe("2026-06-11 15:00:00.000");
    expect(ceilTimestamp("2026-06-11 15")).toBe("2026-06-11 15:59:59.999");
  });

  it("widens a day label and a minute label correctly", () => {
    expect(floorTimestamp("2026-06-11")).toBe("2026-06-11 00:00:00.000");
    expect(ceilTimestamp("2026-06-11")).toBe("2026-06-11 23:59:59.999");
    expect(floorTimestamp("2026-06-11 15:18")).toBe("2026-06-11 15:18:00.000");
    expect(ceilTimestamp("2026-06-11 15:18")).toBe("2026-06-11 15:18:59.999");
  });

  it("leaves a full-precision timestamp unchanged", () => {
    const full = "2026-06-11 15:18:06.569";
    expect(floorTimestamp(full)).toBe(full);
    expect(ceilTimestamp(full)).toBe(full);
  });

  it("widens a seconds-precision bound (length 19) correctly", () => {
    expect(floorTimestamp("2026-06-11 15:18:06")).toBe("2026-06-11 15:18:06.000");
    expect(ceilTimestamp("2026-06-11 15:18:06")).toBe("2026-06-11 15:18:06.999");
  });

  it("does NOT corrupt a non-bucket-aligned partial bound — widens to the coarser period instead", () => {
    // "2026-06-11 1" (length 12) lands mid-hour-field. The old slice-append produced
    // "2026-06-11 10:00:00.000" (hour 1 silently became hour 10). It must instead round
    // DOWN to the day boundary so the range only ever WIDENS (never wrongly excludes).
    expect(floorTimestamp("2026-06-11 1")).toBe("2026-06-11 00:00:00.000");
    expect(ceilTimestamp("2026-06-11 1")).toBe("2026-06-11 23:59:59.999");
    // A mid-minute partial (length 15) rounds down to the hour.
    expect(floorTimestamp("2026-06-11 15:1")).toBe("2026-06-11 15:00:00.000");
    expect(ceilTimestamp("2026-06-11 15:1")).toBe("2026-06-11 15:59:59.999");
  });
});

describe("aggregateTimeline", () => {
  it("buckets WARN+ lines by hour and counts per severity", async () => {
    const r = await aggregateTimeline(logPath, { minSeverity: "WARN", granularity: "hour" });
    expect(r.buckets).toHaveLength(2);

    const h15 = r.buckets.find((b) => b.bucket === "2026-06-11 15");
    expect(h15?.counts).toEqual({ WARN: 1, ERROR: 1 });

    const h16 = r.buckets.find((b) => b.bucket === "2026-06-11 16");
    expect(h16?.counts).toEqual({ ERROR: 1 });
  });

  it("excludes INFO lines at the default WARN threshold", async () => {
    const r = await aggregateTimeline(logPath, {});
    expect(r.totalCounted).toBe(3); // 1 WARN + 2 ERROR; the 2 INFO lines excluded
  });

  it("restricts to a single rank", async () => {
    const r = await aggregateTimeline(logPath, { minSeverity: "INFO", rank: "r1" });
    expect(r.totalCounted).toBe(2);
  });

  it("supports day and minute granularity", async () => {
    const day = await aggregateTimeline(logPath, { granularity: "day" });
    expect(day.buckets).toHaveLength(1);
    expect(day.buckets[0].bucket).toBe("2026-06-11");

    const minute = await aggregateTimeline(logPath, { granularity: "minute", minSeverity: "WARN" });
    expect(minute.buckets.map((b) => b.bucket)).toContain("2026-06-11 15:18");
  });

  it("returns an error result for a missing file (never throws)", async () => {
    const r = await aggregateTimeline(join(dir, "nope.log"), {});
    expect(r.error).toBeDefined();
  });
});
