import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "./bundle-index.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bundle-idx-"));
  await mkdir(join(dir, "logs-local"), { recursive: true });
  await writeFile(join(dir, "gpudb_core_etc_gpudb.conf"), "[gaia]\nfile_version = 7.2.3\n");
  await writeFile(join(dir, "mem.txt"), "EXEC_CMD: free -m\nMem: 1\n");
  await writeFile(join(dir, "logs-local", "core-gpudb-rolling-r0.log"), "line\n");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("buildIndex", () => {
  it("walks recursively and classifies each file with its size", async () => {
    const index = await buildIndex(dir);
    const conf = index.find((e) => e.relPath === "gpudb_core_etc_gpudb.conf");
    expect(conf?.kind).toBe("config");
    expect(conf?.sizeBytes).toBeGreaterThan(0);

    const log = index.find((e) => e.relPath === "logs-local/core-gpudb-rolling-r0.log");
    expect(log?.kind).toBe("core-log");
    expect(log?.rank).toBe("r0");
  });

  it("returns entries sorted by relative path", async () => {
    const index = await buildIndex(dir);
    const paths = index.map((e) => e.relPath);
    expect(paths).toEqual([...paths].sort());
  });

  it("returns an empty index for a nonexistent directory (never throws)", async () => {
    expect(await buildIndex(join(dir, "nope"))).toEqual([]);
  });

  it("excludes symlinks so a malicious bundle cannot escape the root", async () => {
    // A support bundle is untrusted input (extracted from a tarball, which
    // preserves symlinks). A symlink inside the bundle pointing OUTSIDE it must
    // never be indexed — otherwise the file readers would follow it and leak the
    // target (e.g. /etc/shadow, ~/.ssh/id_rsa) into the model context.
    const bundleDir = await mkdtemp(join(tmpdir(), "bundle-sym-"));
    const escapeDir = await mkdtemp(join(tmpdir(), "bundle-escape-"));
    try {
      const secret = join(escapeDir, "secret.log");
      await writeFile(secret, "TOP SECRET\n");
      await writeFile(join(bundleDir, "mem.txt"), "EXEC_CMD: free\n");
      await symlink(secret, join(bundleDir, "evil.log"));

      const index = await buildIndex(bundleDir);

      // The symlink is not indexed, and nothing points outside the bundle root.
      expect(index.some((e) => e.relPath === "evil.log")).toBe(false);
      expect(index.every((e) => !e.absPath.includes("bundle-escape-"))).toBe(true);
      // The genuine file is still indexed (the fix excludes only symlinks).
      expect(index.some((e) => e.relPath === "mem.txt")).toBe(true);
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
      await rm(escapeDir, { recursive: true, force: true });
    }
  });
});
