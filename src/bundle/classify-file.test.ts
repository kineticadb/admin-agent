import { describe, it, expect } from "vitest";
import { classifyFile } from "./classify-file.js";

describe("classifyFile", () => {
  it("classifies per-rank rolling logs as core-log with the rank", () => {
    expect(classifyFile("logs-local/core-gpudb-rolling-r0.log")).toMatchObject({
      kind: "core-log",
      rank: "r0",
    });
    expect(classifyFile("logs-local/core-gpudb-rolling-r1.log")).toMatchObject({
      kind: "core-log",
      rank: "r1",
    });
  });

  it("classifies the host-manager rolling log as core-log with the host-manager SERVICE, not a rank", () => {
    // "hm" is the host-manager service (singleton, port 9300), NOT a rank. Filing it
    // under `service` keeps the rank vocabulary numeric so per-line rank filters and
    // the inventory `ranks` list never see a service name.
    const c = classifyFile("logs-local/core-gpudb-rolling-hm.log");
    expect(c).toMatchObject({ kind: "core-log", service: "host-manager" });
    expect(c.rank).toBeUndefined();
  });

  it("classifies other logs-local logs as component-log with a component name", () => {
    expect(classifyFile("logs-local/sql-engine.log")).toMatchObject({
      kind: "component-log",
      component: "sql-engine",
    });
    expect(classifyFile("logs-local/reveal.log")).toMatchObject({
      kind: "component-log",
      component: "reveal",
    });
  });

  it("derives a clean component name from a core-gpudb / node-suffixed log", () => {
    expect(classifyFile("logs-local/graph-gpudb-graph-0-node2.log").component).toBe(
      "graph-gpudb-graph-0",
    );
    expect(classifyFile("logs-local/core-gpudb-host-manager-service-node2.log").component).toBe(
      "host-manager-service",
    );
  });

  it("strips a doubled .log suffix and host suffix from stats sub-service component logs", () => {
    // Real bundles ship stats sub-logs with a doubled extension, e.g.
    // logs-local/stats-loki-node2.log.log. Stripping only one ".log" left the host
    // suffix glued on ("stats-loki-node2.log"), so the exact-match component filter
    // never matched. Both ".log" suffixes and the -node host suffix must come off.
    expect(classifyFile("logs-local/stats-loki-node2.log.log")).toMatchObject({
      kind: "component-log",
      component: "stats-loki",
    });
    expect(classifyFile("logs-local/stats-prometheus-node2.log.log").component).toBe(
      "stats-prometheus",
    );
  });

  it("classifies logs/ entries as loki-tail", () => {
    expect(classifyFile("logs/gpudb.log")).toMatchObject({ kind: "loki-tail" });
    expect(classifyFile("logs/rank0.log")).toMatchObject({ kind: "loki-tail" });
  });

  it("classifies .conf files as config", () => {
    expect(classifyFile("gpudb_core_etc_gpudb.conf").kind).toBe("config");
    expect(classifyFile("gpudb_core_etc_gpudb_logger.conf").kind).toBe("config");
  });

  it("classifies gpudb.txt as version-info", () => {
    expect(classifyFile("gpudb.txt").kind).toBe("version-info");
  });

  it("classifies gpudb-exe-*.txt as process-info with rank", () => {
    expect(classifyFile("gpudb-exe-r0-164100.txt")).toMatchObject({
      kind: "process-info",
      rank: "r0",
    });
  });

  it("classifies the host-manager exe capture as process-info with the host-manager SERVICE, not a rank", () => {
    const c = classifyFile("gpudb-exe-hm-152573.txt");
    expect(c).toMatchObject({ kind: "process-info", service: "host-manager" });
    expect(c.rank).toBeUndefined();
  });

  it("classifies errors.txt and the proc-logs-erros typo as collection-errors", () => {
    expect(classifyFile("errors.txt").kind).toBe("collection-errors");
    expect(classifyFile("logs-local/proc-logs-erros.txt").kind).toBe("collection-errors");
  });

  it("does NOT treat a prefixed correct-spelling dump as collection-errors", () => {
    // query-errors.txt is a data dump, not the bundle's collection-failure summary.
    expect(classifyFile("query-errors.txt").kind).not.toBe("collection-errors");
    expect(classifyFile("logs-local/db-errors.txt").kind).not.toBe("collection-errors");
  });

  it("classifies logfiles.txt as manifest", () => {
    expect(classifyFile("logs-local/logfiles.txt").kind).toBe("manifest");
  });

  it("classifies generic OS .txt captures as os-diag", () => {
    for (const f of ["mem.txt", "cpu.txt", "disk.txt", "gpu.txt", "net.txt", "sysctl.txt"]) {
      expect(classifyFile(f).kind).toBe("os-diag");
    }
  });

  it("infers host from a node-named path", () => {
    expect(classifyFile("logs-local/sql-engine-node2.log").host).toBe("node2");
  });

  it("falls back to unknown for unrecognized files", () => {
    expect(classifyFile("gpudb_core_bin_gpudb").kind).toBe("unknown");
  });
});
