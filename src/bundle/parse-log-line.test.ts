import { describe, it, expect } from "vitest";
import { parseLogLine, severityRank } from "./parse-log-line.js";

describe("parseLogLine — core rank dialect", () => {
  const line =
    "2026-06-11 15:18:06.573 WARN  (55114,55114,r0/gpudb_cluster_i) node2 GaiaParams.cpp:393 - tcs_per_tom below minimum";

  it("extracts timestamp, severity, pid, tid, context, rank", () => {
    const p = parseLogLine(line);
    expect(p.timestamp).toBe("2026-06-11 15:18:06.573");
    expect(p.severity).toBe("WARN");
    expect(p.pid).toBe("55114");
    expect(p.tid).toBe("55114");
    expect(p.context).toBe("r0/gpudb_cluster_i");
    expect(p.rank).toBe("r0");
  });

  it("extracts host, source location, and message from the core tail", () => {
    const p = parseLogLine(line);
    expect(p.host).toBe("node2");
    expect(p.source).toBe("GaiaParams.cpp:393");
    expect(p.message).toBe("tcs_per_tom below minimum");
  });

  it("preserves the raw line verbatim", () => {
    expect(parseLogLine(line).raw).toBe(line);
  });

  it("handles a source path with directory segments", () => {
    const p = parseLogLine(
      "2026-06-11 15:18:06.569 INFO  (55114,55114,r0/gpudb_cluster_i) node2 App/GaiaApp.cpp:431 - Logger initialized.",
    );
    expect(p.source).toBe("App/GaiaApp.cpp:431");
    expect(p.message).toBe("Logger initialized.");
  });
});

describe("parseLogLine — component dialect (no source:line, no ' - ')", () => {
  const line =
    "2026-06-11 15:18:03.000 INFO (54820,1,sql) gpudb-sql-engine.sh Starting Kinetica SQL Engine";

  it("parses prefix and treats the remainder as the message", () => {
    const p = parseLogLine(line);
    expect(p.timestamp).toBe("2026-06-11 15:18:03.000");
    expect(p.severity).toBe("INFO");
    expect(p.pid).toBe("54820");
    expect(p.tid).toBe("1");
    expect(p.context).toBe("sql");
    expect(p.message).toBe("gpudb-sql-engine.sh Starting Kinetica SQL Engine");
  });

  it("leaves rank undefined when context is a component name", () => {
    expect(parseLogLine(line).rank).toBeUndefined();
  });

  it("leaves host and source undefined for the component dialect", () => {
    const p = parseLogLine(line);
    expect(p.host).toBeUndefined();
    expect(p.source).toBeUndefined();
  });
});

describe("parseLogLine — tolerant fallback", () => {
  it("returns the raw line as the message when there is no timestamp prefix", () => {
    const p = parseLogLine("    at com.gpudb.Foo.bar(Foo.java:42)");
    expect(p.timestamp).toBeUndefined();
    expect(p.severity).toBeUndefined();
    expect(p.message).toBe("    at com.gpudb.Foo.bar(Foo.java:42)");
    expect(p.raw).toBe("    at com.gpudb.Foo.bar(Foo.java:42)");
  });

  it("handles an empty line without throwing", () => {
    const p = parseLogLine("");
    expect(p.message).toBe("");
  });

  it("recognizes the UERR severity", () => {
    const p = parseLogLine(
      "2026-06-11 15:20:00.000 UERR  (1,1,r0/x) node2 Foo.cpp:1 - bad user input",
    );
    expect(p.severity).toBe("UERR");
  });

  it("recognizes FATAL severity", () => {
    const p = parseLogLine("2026-06-11 15:20:00.000 FATAL (1,1,r1/x) node2 Foo.cpp:1 - dying");
    expect(p.severity).toBe("FATAL");
    expect(p.rank).toBe("r1");
  });
});

describe("parseLogLine — Loki JSONL dialect (logs/rank*.log)", () => {
  const rec =
    '{"labels":{"level":"error"},"line":"2026-06-17 18:25:57.319 error gpudb_log rank-3 :  ERROR  (530352,533249,r3/gpudb_gsetmgr  ) 300-303-u31-v100 TypeManagement/GaiaSetData.cpp:1271 - shard failover","timestamp":"2026-06-17T18:25:57.319Z"}';

  it("unwraps the JSON envelope and parses the nested Kinetica line", () => {
    const p = parseLogLine(rec);
    expect(p.timestamp).toBe("2026-06-17 18:25:57.319");
    expect(p.severity).toBe("ERROR"); // uppercase from the body, not the lowercase Loki level
    expect(p.rank).toBe("r3");
    expect(p.source).toBe("TypeManagement/GaiaSetData.cpp:1271");
    expect(p.message).toBe("shard failover");
  });

  it("keeps raw as the ORIGINAL JSONL line so regex search tests true content", () => {
    expect(parseLogLine(rec).raw).toBe(rec);
  });

  it("severity is filterable — the headline bug was severity coming back undefined", () => {
    // Before unwrapping, parseLogLine saw a line starting with '{' → no severity →
    // every minSeverity filter silently dropped it. Now it ranks as a real ERROR.
    expect(severityRank(parseLogLine(rec).severity)).toBe(severityRank("ERROR"));
  });
});

describe("severityRank", () => {
  it("orders severities from least to most severe", () => {
    expect(severityRank("INFO")).toBeLessThan(severityRank("WARN"));
    expect(severityRank("WARN")).toBeLessThan(severityRank("UERR"));
    expect(severityRank("UERR")).toBeLessThan(severityRank("ERROR"));
    expect(severityRank("ERROR")).toBeLessThan(severityRank("FATAL"));
  });

  it("returns -1 for unknown or absent severity", () => {
    expect(severityRank(undefined)).toBe(-1);
    expect(severityRank("BOGUS")).toBe(-1);
  });
});
