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

  it("classifies a ROTATED rolling log (.log.1) as core-log with the rank — not unknown", () => {
    // Rotated history (core-gpudb-rolling-r0.log.1) carries older lines for the same
    // rank. It used to fall to `unknown` (the gate required a bare .log suffix), so
    // that history was indexed but searchable by no tool.
    expect(classifyFile("logs-local/core-gpudb-rolling-r0.log.1")).toMatchObject({
      kind: "core-log",
      rank: "r0",
    });
    expect(classifyFile("logs-local/core-gpudb-rolling-r1.log.2")).toMatchObject({
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

  it("tags Loki per-rank logs (logs/rank<N>.log) with the numeric rank", () => {
    // A Loki-based collector exports one log per rank cluster-wide. These are the
    // ONLY evidence for ranks on hosts the collector didn't run on (absent from
    // logs-local). They must carry a `rank` so inventory + per-rank selection see them.
    expect(classifyFile("logs/rank0.log")).toMatchObject({ kind: "loki-tail", rank: "r0" });
    expect(classifyFile("logs/rank2.log")).toMatchObject({ kind: "loki-tail", rank: "r2" });
    expect(classifyFile("logs/rank8.log")).toMatchObject({ kind: "loki-tail", rank: "r8" });
    // …and NOT a bogus component name (the old behavior left component:"rank2").
    expect(classifyFile("logs/rank2.log").component).toBeUndefined();
  });

  it("tags the Loki host-manager export (logs/hostmanager.log) as the host-manager SERVICE, not a rank", () => {
    const c = classifyFile("logs/hostmanager.log");
    expect(c).toMatchObject({ kind: "loki-tail", service: "host-manager" });
    expect(c.rank).toBeUndefined();
    expect(c.component).toBeUndefined();
  });

  it("keeps non-rank logs/ entries as component-named loki-tails", () => {
    // Service/component tails under logs/ (graph, sql, tomcat) still get a component
    // name — only rank<N>.log and hostmanager.log are special-cased above.
    expect(classifyFile("logs/graph.log")).toMatchObject({
      kind: "loki-tail",
      component: "graph",
    });
    expect(classifyFile("logs/sql.log").rank).toBeUndefined();
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
