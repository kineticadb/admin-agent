/**
 * Redaction tests for the two bundle tools that return arbitrary text.
 *
 * ps.txt process args and environment dumps carry credentials; logged SQL
 * carries IDENTIFIED BY / SET PASSWORD. Both now pass through
 * scrubCredentialPatterns, which is narrow on purpose: host diagnostics and log
 * lines are the evidence these tools exist to surface.
 */
import { describe, it, expect } from "vitest";
import { bundleReadSysinfo } from "./read-sysinfo.js";
import { bundleSearchLogs } from "./search-logs.js";
import type { BundleSource } from "../../bundle/BundleSource.js";

function sysinfoSource(command: string, output: string): BundleSource {
  return {
    readSysinfo: () => Promise.resolve({ header: "ps.txt", blocks: [{ command, output }] }),
  } as unknown as BundleSource;
}

function logSource(message: string): BundleSource {
  return {
    searchLogs: () =>
      Promise.resolve({
        matches: [{ file: "r0.log", lineNumber: 1, message }],
        totalMatched: 1,
        linesScanned: 1,
        filesScanned: ["r0.log"],
        capped: false,
      }),
  } as unknown as BundleSource;
}

const text = (r: { ok: boolean; data?: unknown }) => JSON.stringify(r.ok ? r.data : r);

describe("bundleReadSysinfo — inline credentials masked", () => {
  it.each([
    [
      "process arg",
      "ps -ef",
      "gpudb 1234 tool --user=admin --password=hunter2 --host=n2",
      "hunter2",
    ],
    ["env dump", "env", "KINETICA_PASS=hunter2\nPATH=/usr/bin", "hunter2"],
    ["aws env", "env", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI", "wJalrXUtnFEMI"],
    ["url userinfo", "ps -ef", "psql postgresql://admin:hunter2@dbhost.example:5432/db", "hunter2"],
  ])("masks a %s", async (_l, cmd, out, secret) => {
    const r = await bundleReadSysinfo(sysinfoSource(cmd, out), { name: "ps.txt" });
    expect(r.ok).toBe(true);
    expect(text(r)).not.toContain(secret);
  });

  it("masks a credential in the command itself", async () => {
    const r = await bundleReadSysinfo(sysinfoSource("tool --password=hunter2", "ok"), {
      name: "ps.txt",
    });
    expect(text(r)).not.toContain("hunter2");
  });

  it("leaves host diagnostics intact", async () => {
    const out = "MemTotal: 6748150 kB\nHugePages_Total: 0\ngpudb 74100 ps -p 74100 -o comm=";
    const r = await bundleReadSysinfo(sysinfoSource("cat /proc/meminfo", out), { name: "mem.txt" });
    const t = text(r);
    expect(t).toContain("6748150");
    expect(t).toContain("74100");
    expect(t).not.toContain("[REDACTED]");
  });
});

describe("bundleSearchLogs — inline credentials masked", () => {
  it.each([
    ["Executing SQL: CREATE USER bob IDENTIFIED BY 'hunter2'", "hunter2"],
    ["Executing SQL: ALTER USER bob SET PASSWORD 'hunter2'", "hunter2"],
    ["Executing SQL: SELECT * FROM t WHERE password = 'hunter2'", "hunter2"],
  ])("masks %s", async (message, secret) => {
    const r = await bundleSearchLogs(logSource(message), {});
    expect(r.ok).toBe(true);
    expect(text(r)).not.toContain(secret);
  });

  it("leaves ordinary log evidence byte-identical", async () => {
    const message = "Rank0RamPool::acquire failed: Avail 793900000, requested 8000";
    const r = await bundleSearchLogs(logSource(message), {});
    expect(text(r)).toContain("Avail 793900000");
    expect(text(r)).not.toContain("[REDACTED]");
  });

  it("does not gut a line that merely mentions a password", async () => {
    const message = "password policy check failed for user bob";
    const r = await bundleSearchLogs(logSource(message), {});
    expect(text(r)).toContain("password policy check failed for user bob");
  });
});
