import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyBundle } from "./verify-bundle.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "bundle-verify-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("verifyBundle — happy path", () => {
  it("verifies a well-formed bundle and summarizes inventory", async () => {
    const dir = join(root, "good");
    await mkdir(join(dir, "logs-local"), { recursive: true });
    await writeFile(join(dir, "gpudb_core_etc_gpudb.conf"), "[gaia]\nfile_version = 7.2.3.17\n");
    await writeFile(
      join(dir, "logs-local", "core-gpudb-rolling-r0.log"),
      "2026-06-11 15:18:06.569 INFO  (1,1,r0/c) node2 App.cpp:1 - boot\n",
    );

    const r = await verifyBundle(dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kineticaVersion).toBe("7.2.3.17");
      expect(r.inventory.byKind["core-log"]).toBe(1);
      expect(r.inventory.ranks).toEqual(["r0"]);
      expect(r.missingExpected).toEqual([]);
    }
  });

  it("classifies a canonical bundle's layout as canonical (no warning)", async () => {
    const dir = join(root, "canonical");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "gpudb_core_etc_gpudb.conf"), "[gaia]\nfile_version = 7.2.3\n");
    await writeFile(join(dir, "gpudb.txt"), "EXEC_CMD: gpudb -v\nGPUdb version : 7.2.3\n");
    await writeFile(join(dir, "mem.txt"), "EXEC_CMD: free -m\nMem: 1\n");
    await writeFile(
      join(dir, "core-gpudb-rolling-r0.log"),
      "2026-06-11 15:18:06.569 INFO  (1,1,r0/c) node2 App.cpp:1 - boot\n",
    );

    const r = await verifyBundle(dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.layout).toBe("canonical");
      expect(r.layoutWarning).toBeUndefined();
    }
  });

  it("flags an off-shape logs-only bundle as unfamiliar, with a warning", async () => {
    // No config, no version, no os-diag — a bare logs dump like the db06 bundle.
    const dir = join(root, "logs-only");
    await mkdir(dir, { recursive: true });
    for (const rank of ["r0", "r1"]) {
      await writeFile(
        join(dir, `gpudb-rolling-${rank}.log`),
        `2026-06-16 07:52:08.510 INFO  (1,2,${rank}/c) DB-6 App.cpp:1 - x\n`,
      );
    }
    await writeFile(
      join(dir, "gpudb-host-manager-DB-6.out"),
      "CPU ARCH: intel:1\n2026-01-31 15:13:41.910 INFO  (4525,4525,hm/x) DB-6 HM.cpp:1 - up\n",
    );

    const r = await verifyBundle(dir);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.layout).toBe("unfamiliar");
      expect(r.layoutWarning).toMatch(/does not match the canonical/i);
      // The headline win: the prefixless rolling logs still surface their ranks.
      expect(r.inventory.ranks).toEqual(["r0", "r1"]);
    }
  });

  it("flags missing expected artifacts without failing", async () => {
    const dir = join(root, "no-logs");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "gpudb_core_etc_gpudb.conf"), "[gaia]\nfile_version = 7.2.3\n");

    const r = await verifyBundle(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.missingExpected).toContain("core-log");
  });
});

describe("verifyBundle — error paths", () => {
  it("fails fast on a nonexistent path", async () => {
    const r = await verifyBundle(join(root, "nope"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not exist/);
  });

  it("tells the user to extract a .tgz archive", async () => {
    const archive = join(root, "bundle.tgz");
    await writeFile(archive, "not really a tarball");
    const r = await verifyBundle(archive);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/extracted directory/);
  });

  it("fails on an empty directory", async () => {
    const dir = join(root, "empty");
    await mkdir(dir, { recursive: true });
    const r = await verifyBundle(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no readable files/);
  });
});
