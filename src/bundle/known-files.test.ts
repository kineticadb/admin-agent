import { describe, it, expect } from "vitest";
import { describeBundleFile, KNOWN_BUNDLE_FILES } from "./known-files.js";

describe("describeBundleFile", () => {
  it("describes a canonical OS-diag file by basename", () => {
    expect(describeBundleFile({ relPath: "mem.txt", kind: "os-diag" })).toMatch(/free -m/);
    expect(describeBundleFile({ relPath: "gpu.txt", kind: "os-diag" })).toMatch(/nvidia-smi/);
  });

  it("matches by basename regardless of directory prefix", () => {
    expect(
      describeBundleFile({ relPath: "logs-local/proc-logs-erros.txt", kind: "collection-errors" }),
    ).toMatch(/Evidence Gaps/i);
  });

  it("falls back to a per-kind description for non-canonical filenames", () => {
    // A rolling core log has a per-rank filename not in the static map.
    const desc = describeBundleFile({
      relPath: "logs-local/core-gpudb-rolling-r0.log",
      kind: "core-log",
    });
    expect(desc).toMatch(/rolling/i);
  });

  it("describes per-rank process-info files (PID-suffixed) via the kind fallback", () => {
    const desc = describeBundleFile({ relPath: "gpudb-exe-r0-164100.txt", kind: "process-info" });
    expect(desc).toMatch(/environment/i);
  });

  it("returns empty string when nothing is known (graceful)", () => {
    expect(describeBundleFile({ relPath: "gpudb_sysinfo.sh", kind: "unknown" })).toBe("");
  });

  it("covers every os-diag file in a real node bundle", () => {
    const realOsDiag = [
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
    ];
    for (const name of realOsDiag) {
      expect(KNOWN_BUNDLE_FILES[name], `missing description for ${name}`).toBeDefined();
    }
  });
});
