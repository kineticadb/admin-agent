import { describe, it, expect } from "vitest";
import { unwrapLokiJsonl } from "./unwrap-loki-jsonl.js";

describe("unwrapLokiJsonl", () => {
  it("reconstructs a standard <ts> <body> line from a rank JSONL record", () => {
    const rec =
      '{"labels":{"level":"info"},"line":"2026-06-17 18:25:57.319 info gpudb_log rank-0 :  INFO  (906186,907730,r0/gpudb_gblreg   ) 300-303-u30-v100 Utils/CommunicatorUtils.cpp:1406 - All ranks expected active: 0","timestamp":"2026-06-17T18:25:57.319Z"}';
    expect(unwrapLokiJsonl(rec)?.line).toBe(
      "2026-06-17 18:25:57.319 INFO  (906186,907730,r0/gpudb_gblreg   ) 300-303-u30-v100 Utils/CommunicatorUtils.cpp:1406 - All ranks expected active: 0",
    );
  });

  it("handles an empty app field (double space before the separator)", () => {
    const rec =
      '{"labels":{"level":"info"},"line":"2026-06-17 18:23:58.15 info gpudb_sql_log  :  INFO  (905008,48,sql) run:210 - Query planner worker started","timestamp":"2026-06-17T18:23:58.15Z"}';
    // Loki trims trailing zeros; millisecond width keeps ".150" bounds comparable.
    expect(unwrapLokiJsonl(rec)?.line).toBe(
      "2026-06-17 18:23:58.150 INFO  (905008,48,sql) run:210 - Query planner worker started",
    );
  });

  it("preserves the original UPPERCASE severity (not the lowercase Loki level)", () => {
    const rec =
      '{"labels":{"level":"error"},"line":"2026-06-17 18:25:57.319 error gpudb_log rank-3 :  ERROR  (1,1,r3/c) host X.cpp:1 - boom","timestamp":"2026-06-17T18:25:57.319Z"}';
    // The reconstructed line carries "ERROR" so the severity-rank filter works.
    expect(unwrapLokiJsonl(rec)?.line).toContain(" ERROR  (1,1,r3/c)");
  });

  it("returns undefined for a raw (non-JSON) Kinetica log line", () => {
    const raw = "2026-06-11 15:18:06.569 INFO  (1,1,r0/c) node2 App.cpp:1 - boot";
    expect(unwrapLokiJsonl(raw)).toBeUndefined();
  });

  it("returns undefined for a header / non-JSON line", () => {
    expect(unwrapLokiJsonl("----------------------------------------------------")).toBeUndefined();
    expect(unwrapLokiJsonl("Rank 0 logs from promtail in Loki.")).toBeUndefined();
  });

  it("returns undefined for malformed JSON rather than throwing", () => {
    expect(unwrapLokiJsonl('{"line": "broken')).toBeUndefined();
  });

  it("returns the inner line as-is when it lacks a Loki header separator", () => {
    // A continuation/stack line Loki captured whole — no "<ts> <level> <job> <app> :" prefix.
    const rec = '{"labels":{},"line":"  at GaiaApp::run() frame 3"}';
    expect(unwrapLokiJsonl(rec)?.line).toBe("  at GaiaApp::run() frame 3");
  });

  it("reports where the emitted stamp came from, so the caller need not infer it", () => {
    const utcField =
      '{"line":"2026-06-17 18:25:57.319 info gpudb_log rank-0 :  INFO  (1,1,r0/c) h X.cpp:1 - m","timestamp":"2026-06-17T18:25:57.319Z"}';
    const rendered =
      '{"line":"2026-06-17 18:25:57.319 info gpudb_log rank-0 :  INFO  (1,1,r0/c) h X.cpp:1 - m"}';
    // No Loki header, so the stamp is Kinetica's.
    const passthrough = '{"line":"2026-06-17 11:25:57.319 INFO  (1,1,r0/c) h X.cpp:1 - m"}';
    expect(unwrapLokiJsonl(utcField)?.stampSource).toBe("utc-field");
    expect(unwrapLokiJsonl(rendered)?.stampSource).toBe("rendered");
    expect(unwrapLokiJsonl(passthrough)?.stampSource).toBe("passthrough");
  });

  it("returns undefined when the JSON has no string line field", () => {
    expect(unwrapLokiJsonl('{"labels":{"level":"info"},"timestamp":"x"}')).toBeUndefined();
    expect(unwrapLokiJsonl('{"line": 42}')).toBeUndefined();
  });
  it("takes the stamp from the record's `timestamp` field (RFC 3339 UTC) when it differs from the rendered one", () => {
    // The `timestamp` field is UTC by format; the rendered stamp's zone is not.
    const rec =
      '{"labels":{"level":"info"},"line":"2026-06-17 11:25:57.319 info gpudb_log rank-0 :  INFO  (1,1,r0/c) host X.cpp:1 - m","timestamp":"2026-06-17T18:25:57.319Z"}';
    expect(unwrapLokiJsonl(rec)?.line).toBe(
      "2026-06-17 18:25:57.319 INFO  (1,1,r0/c) host X.cpp:1 - m",
    );
  });

  it("normalizes the UTC field's fraction to milliseconds (nanosecond and whole-second forms)", () => {
    const nano =
      '{"line":"2026-06-17 18:25:57.319 info gpudb_log rank-0 :  INFO  (1,1,r0/c) h X.cpp:1 - m","timestamp":"2026-06-17T18:25:57.319123456Z"}';
    expect(unwrapLokiJsonl(nano)?.line).toMatch(/^2026-06-17 18:25:57\.319 INFO/);
    const whole =
      '{"line":"2026-06-17 18:25:57.000 info gpudb_log rank-0 :  INFO  (1,1,r0/c) h X.cpp:1 - m","timestamp":"2026-06-17T18:25:57Z"}';
    expect(unwrapLokiJsonl(whole)?.line).toMatch(/^2026-06-17 18:25:57\.000 INFO/);
  });

  it("falls back to the rendered stamp when the record has no UTC timestamp field", () => {
    const rec =
      '{"labels":{"level":"info"},"line":"2026-06-17 18:25:57.319 info gpudb_log rank-0 :  INFO  (1,1,r0/c) host X.cpp:1 - m"}';
    expect(unwrapLokiJsonl(rec)?.line).toBe(
      "2026-06-17 18:25:57.319 INFO  (1,1,r0/c) host X.cpp:1 - m",
    );
  });
});
