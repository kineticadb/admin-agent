/**
 * Classification coverage guard, derived from a REAL gpudb_sysinfo bundle
 * (gpudb-sysinfo-node2-*, 77 files, single node with ranks r0/r1 + host manager).
 *
 * Only the relative PATHS are embedded here — never the contents — because a real
 * bundle carries live secrets (gpudb.conf license keys, LDAP binds) and is
 * gitignored. classifyFile is pure on the path string, so paths alone fully pin
 * coverage. If the classifier logic regresses, or a future collector layout drifts,
 * this test catches it without needing the (secret-bearing) bundle present in CI.
 *
 * INVARIANT: embed relative PATHS only — NEVER file contents. The contents carry
 * secrets; the paths do not. Do not "make it realistic" by pasting in file bodies.
 *
 * To refresh/extend (e.g. for a newer collector layout): extract a real bundle, list
 * its relative paths with `find <dir> -type f | sed "s|^<dir>/||" | sort`, and slot
 * each into EXPECTED under the kind it should classify as. Anonymize any non-generic
 * host token before committing (a bare `node2` is fine; `acme-prod-3.internal` is not).
 * Keep this as a snapshot of ONE collector version — add layouts, don't mutate in place.
 */

import { describe, it, expect } from "vitest";
import { classifyFile, type BundleFileKind } from "./classify-file.js";
import { describeBundleFile } from "./known-files.js";

/** Every file in the reference bundle, grouped by the kind it MUST classify as. */
const EXPECTED: Readonly<Record<BundleFileKind, readonly string[]>> = {
  "core-log": [
    "logs-local/core-gpudb-rolling-hm.log",
    "logs-local/core-gpudb-rolling-r0.log",
    "logs-local/core-gpudb-rolling-r1.log",
  ],
  "component-log": [
    "logs-local/core-gpudb-host-manager-service-node2.log",
    "logs-local/core-gpudb-service-node2.log",
    "logs-local/graph-gpudb-graph-0-node2.log",
    "logs-local/httpd.log",
    "logs-local/odbc.log",
    "logs-local/ranger-authorizer.log",
    "logs-local/reveal.log",
    "logs-local/sql-engine.log",
    "logs-local/stats-alertmanager-node2.log.log",
    "logs-local/stats-alertmanager_logger-node2.log.log",
    "logs-local/stats-gpudb-stats-node2.log.log",
    "logs-local/stats-grafana-node2.log.log",
    "logs-local/stats-loki-node2.log.log",
    "logs-local/stats-metrics_collector-node2.log.log",
    "logs-local/stats-metrics_worker-node2.log.log",
    "logs-local/stats-prometheus-node2.log.log",
    "logs-local/tomcat-access.log",
    "logs-local/tomcat.log",
    "logs-local/workbench.log",
  ],
  "loki-tail": [
    "logs/alertmanager.log",
    "logs/etcd.log",
    "logs/events.log",
    "logs/gpudb.log",
    "logs/grafana.log",
    "logs/graph.log",
    "logs/hostmanager.log",
    "logs/httpd_access.log",
    "logs/httpd_error.log",
    "logs/loki.log",
    "logs/prometheus.log",
    "logs/promtail.log",
    "logs/rabbitmq.log",
    "logs/rank0.log",
    "logs/rank1.log",
    "logs/reveal.log",
    "logs/sql-queries.log",
    "logs/sql.log",
    "logs/text.log",
    "logs/tomcat.log",
    "logs/tomcat_access.log",
    "logs/workbench.log",
  ],
  config: ["gpudb_core_etc_gpudb.conf", "gpudb_core_etc_gpudb_logger.conf"],
  "version-info": ["gpudb.txt"],
  "process-info": ["gpudb-exe-hm-152573.txt", "gpudb-exe-r0-164100.txt", "gpudb-exe-r1-165116.txt"],
  "collection-errors": ["errors.txt", "logs-local/proc-logs-erros.txt"],
  manifest: ["logs-local/logfiles.txt"],
  "os-diag": [
    "cpu.txt",
    "deb.txt",
    "disk.txt",
    "dmesg.txt",
    "dmidecode.txt",
    "etc_bashrc.txt",
    "etc_host.txt",
    "etc_profile.txt",
    "gpu.txt",
    "gpudb-exe.txt",
    "ld.so.conf.txt",
    "loki-info.txt",
    "lshw.txt",
    "lslocks.txt",
    "lsof.txt",
    "mem.txt",
    "net.txt",
    "pci.txt",
    "ps.txt",
    "sys.txt",
    "sysctl.txt",
    "user.txt",
  ],
  // Non-diagnostic blobs: the gpudb launcher script and the collector script itself.
  unknown: ["gpudb_core_bin_gpudb", "gpudb_sysinfo.sh"],
};

describe("real bundle coverage (node2 fixture)", () => {
  it("classifies all 77 files into their expected kinds", () => {
    for (const [kind, paths] of Object.entries(EXPECTED)) {
      for (const path of paths) {
        expect(classifyFile(path).kind, `${path} should classify as ${kind}`).toBe(kind);
      }
    }
  });

  it("extracts the rank from per-rank artifacts (core logs + process-info)", () => {
    expect(classifyFile("logs-local/core-gpudb-rolling-r0.log").rank).toBe("r0");
    expect(classifyFile("gpudb-exe-r1-165116.txt").rank).toBe("r1");
  });

  it("files the host manager under service (NOT rank) — it is a singleton service, not a rank", () => {
    const hmLog = classifyFile("logs-local/core-gpudb-rolling-hm.log");
    expect(hmLog.service).toBe("host-manager");
    expect(hmLog.rank).toBeUndefined();

    const hmExe = classifyFile("gpudb-exe-hm-152573.txt");
    expect(hmExe.service).toBe("host-manager");
    expect(hmExe.rank).toBeUndefined();
  });

  it("covers the full 77-file bundle and nothing falls to unknown except the 2 known blobs", () => {
    const all = Object.values(EXPECTED).flat();
    expect(all).toHaveLength(77);
    const unknowns = all.filter((p) => classifyFile(p).kind === "unknown");
    expect(unknowns.sort()).toEqual(["gpudb_core_bin_gpudb", "gpudb_sysinfo.sh"]);
  });

  it("has a description for every diagnostic file (only the 2 blobs are undescribed)", () => {
    const all = Object.values(EXPECTED).flat();
    const undescribed = all.filter(
      (p) => describeBundleFile({ relPath: p, kind: classifyFile(p).kind }) === "",
    );
    expect(undescribed.sort()).toEqual(["gpudb_core_bin_gpudb", "gpudb_sysinfo.sh"]);
  });
});
