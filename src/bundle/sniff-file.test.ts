import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sniffFile } from "./sniff-file.js";

let dir: string;

const write = async (name: string, content: string): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sniff-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sniffFile", () => {
  it("recognizes a Kinetica core log and recovers the rank from the log context", async () => {
    const p = await write(
      "mystery-a",
      "2026-06-16 07:52:08.510 INFO  (2440729,2450823,r0/gpudb_ep_177) DB-6 Sql/SqlDriver.cpp:1967 - JobId:971413\n",
    );
    const r = await sniffFile(p);
    expect(r).toMatchObject({ kind: "core-log", rank: "r0" });
  });

  it("recognizes a log behind a non-log preamble line (scans the window, not just line 1)", async () => {
    // Host-manager .out captures open with a "CPU ARCH: …" preamble before the log lines.
    const p = await write(
      "hm-like.out",
      [
        "CPU ARCH: intel:1 core2:0 corei7:1",
        "2026-01-31 15:13:41.910 INFO  (4525,4525,hm/gpudb_host_mana) DB-6 HostManager/HostManagerMain.cpp:532 - Process session pid",
      ].join("\n"),
    );
    const r = await sniffFile(p);
    expect(r).toMatchObject({ kind: "component-log", service: "host-manager" });
    expect(r?.rank).toBeUndefined();
  });

  it("recognizes a Loki/promtail JSONL export", async () => {
    const p = await write(
      "loki-like",
      '{"labels":{"level":"info"},"line":"2026-06-17 18:25:57.319 info gpudb_log rank-0 :  INFO  (906186,907730,r0/gpudb_gblreg) host Utils/X.cpp:1406 - msg","timestamp":"2026-06-17T18:25:57.319Z"}\n',
    );
    const r = await sniffFile(p);
    expect(r?.kind).toBe("loki-tail");
  });

  it("recognizes an EXEC_CMD-wrapped sysinfo capture", async () => {
    const p = await write(
      "capture",
      "----\nEXEC_CMD: free -m -t\nMem: 1\nEXEC_END with exit code 0\n",
    );
    const r = await sniffFile(p);
    expect(r?.kind).toBe("os-diag");
  });

  it("recognizes an INI/config file by section + entries", async () => {
    const p = await write(
      "conf-like",
      "# header comment\n[gaia]\nfile_version = 7.2.3\nrank0.host = 10.0.0.1\n",
    );
    const r = await sniffFile(p);
    expect(r?.kind).toBe("config");
  });

  it("does not mistake a log line containing key=value for a config file", async () => {
    const p = await write(
      "noisy.log",
      "2026-06-16 07:52:08.510 INFO  (1,2,r1/ctx) host App.cpp:1 - cache=hit ratio=0.9\n",
    );
    const r = await sniffFile(p);
    expect(r?.kind).toBe("core-log");
    expect(r?.rank).toBe("r1");
  });

  it("returns undefined for content that matches no parser", async () => {
    const p = await write("opaque", "just some prose with no structure at all\nand another line\n");
    expect(await sniffFile(p)).toBeUndefined();
  });

  it("returns undefined for an empty file (never throws)", async () => {
    const p = await write("empty", "");
    expect(await sniffFile(p)).toBeUndefined();
  });

  it("returns undefined for a nonexistent path (never throws)", async () => {
    expect(await sniffFile(join(dir, "does-not-exist"))).toBeUndefined();
  });

  it("never reads beyond headBytes", async () => {
    // A log line sits past a tiny head budget → not seen → no false positive.
    const p = await write(
      "big",
      "x".repeat(5000) + "\n2026-06-16 07:52:08.510 INFO (1,2,r0/c) h a.cpp:1 - m\n",
    );
    expect(await sniffFile(p, { headBytes: 64 })).toBeUndefined();
  });
});
