import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir } from "node:fs/promises";
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

  it("upgrades a weakly-classified file by sniffing its content (recovers the rank)", async () => {
    // A log whose NAME tells us nothing (no rolling pattern, no log dir, odd extension)
    // falls to a weak path classification, but its CONTENT is a standard rank log line.
    // Content sniffing must promote it to core-log and recover the rank.
    const bundleDir = await mkdtemp(join(tmpdir(), "bundle-sniff-"));
    try {
      await writeFile(
        join(bundleDir, "mystery.dat"),
        "2026-06-16 07:52:08.510 INFO  (1,2,r3/gpudb_ep) host App.cpp:1 - hello\n",
      );
      const index = await buildIndex(bundleDir);
      const entry = index.find((e) => e.relPath === "mystery.dat");
      expect(entry?.kind).toBe("core-log");
      expect(entry?.rank).toBe("r3");
      expect(entry?.confidence).toBe("inferred");
      expect(entry?.reason).toMatch(/^content:/);
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
    }
  });

  it("leaves a canonical os-diag .txt untouched (sniff confirms, adds nothing)", async () => {
    const entry = (await buildIndex(dir)).find((e) => e.relPath === "mem.txt");
    expect(entry?.kind).toBe("os-diag");
  });

  it("indexes files by their path RELATIVE to the bundle root (folder name excluded)", async () => {
    // The bundle directory can be named anything (a host id, a ticket number, a random
    // string) — the index must strip it, so classification never depends on it. mkdtemp
    // gives this root an arbitrary name; the indexed relPath must NOT contain it.
    const arbitraryRoot = await mkdtemp(join(tmpdir(), "ANYTHING-the-customer-named-it-"));
    try {
      await writeFile(join(arbitraryRoot, "gpudb-rolling-r0.log"), "x\n");
      const index = await buildIndex(arbitraryRoot);
      const entry = index.find((e) => e.relPath === "gpudb-rolling-r0.log");
      expect(
        entry,
        "relPath must be root-relative, not prefixed with the folder name",
      ).toBeDefined();
      expect(entry?.kind).toBe("core-log");
      expect(entry?.rank).toBe("r0");
    } finally {
      await rm(arbitraryRoot, { recursive: true, force: true });
    }
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

  it("excludes files under a symlinked DIRECTORY that escapes the root", async () => {
    // The subtler escape a leaf-only symlink check misses: readdir(recursive)
    // descends THROUGH a symlinked directory and yields the real files inside the
    // target. Those leaves are genuine regular files — lstat reports
    // isSymbolicLink()===false, isFile()===true — so a leaf-only guard would index
    // them. The realpath confinement must drop anything whose REAL path escapes the
    // bundle root, or a `logs-local → $HOME` symlink leaks ~/.ssh/id_rsa.
    const bundleDir = await mkdtemp(join(tmpdir(), "bundle-symdir-"));
    const escapeDir = await mkdtemp(join(tmpdir(), "bundle-escape-dir-"));
    try {
      // A secret living OUTSIDE the bundle, inside a real directory.
      await mkdir(join(escapeDir, "ssh"), { recursive: true });
      await writeFile(join(escapeDir, "ssh", "id_rsa"), "PRIVATE KEY\n");
      // A genuine in-bundle file — proves the walk still indexes legitimate content.
      await writeFile(join(bundleDir, "mem.txt"), "EXEC_CMD: free\n");
      // `logs-local` is a DIRECTORY symlink pointing outside the bundle root.
      await symlink(join(escapeDir, "ssh"), join(bundleDir, "logs-local"));

      // Precondition: this test only EXERCISES the realpath guard if recursive readdir
      // actually descends THROUGH the directory symlink and presents the escaping leaf to
      // buildIndex. On a platform/Node version that doesn't descend, the leaf is never
      // walked and the assertions below would pass VACUOUSLY (green but testing nothing).
      // Fail loudly here instead, so the security regression can't silently rot.
      const walked = (await readdir(bundleDir, { recursive: true })).map((p) =>
        p.split("\\").join("/"),
      );
      expect(
        walked.includes("logs-local/id_rsa"),
        "precondition: recursive readdir must descend the directory symlink (else this test is vacuous)",
      ).toBe(true);

      const index = await buildIndex(bundleDir);

      // Nothing reached through the symlinked directory is indexed.
      expect(index.some((e) => e.relPath === "logs-local/id_rsa")).toBe(false);
      expect(index.some((e) => e.relPath.startsWith("logs-local/"))).toBe(false);
      // No indexed entry resolves to the escape directory's contents.
      expect(index.every((e) => !e.relPath.includes("id_rsa"))).toBe(true);
      // The genuine in-bundle file is still indexed (the fix drops only escapes).
      expect(index.some((e) => e.relPath === "mem.txt")).toBe(true);
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
      await rm(escapeDir, { recursive: true, force: true });
    }
  });
});
