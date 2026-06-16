/**
 * bundle-index — recursively scan an extracted bundle directory into a
 * classified file index.
 *
 * Walks the directory once, classifies every file by its bundle-relative path
 * (see classify-file), and records its size. The index is the backbone the
 * BundleSource and tools query — nothing else re-walks the tree.
 *
 * Returns an empty index on any filesystem error (graceful degradation).
 */

import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { classifyFile, type BundleFileKind } from "./classify-file.js";

export interface FileIndexEntry {
  /** Path relative to the bundle root, using "/" separators. */
  readonly relPath: string;
  /** Absolute path on disk. */
  readonly absPath: string;
  readonly kind: BundleFileKind;
  /** Numeric rank ("r0", "r1", …). The host manager is NOT a rank — see `service`. */
  readonly rank?: string;
  /** Non-rank cluster service the file belongs to (e.g. "host-manager"). */
  readonly service?: string;
  readonly host?: string;
  readonly component?: string;
  readonly sizeBytes: number;
}

export async function buildIndex(rootDir: string): Promise<readonly FileIndexEntry[]> {
  let relPaths: string[];
  try {
    relPaths = await readdir(rootDir, { recursive: true });
  } catch {
    return [];
  }

  // Stat every entry concurrently rather than awaiting one at a time. A real
  // bundle has thousands of files; a sequential await-in-loop serializes that
  // many round-trips (cheap on local disk, seconds on a network/FUSE mount).
  // Promise.all lets libuv's threadpool overlap them. Directories, symlinks, and
  // unreadable entries resolve to null and are filtered out.
  //
  // SECURITY: use lstat (not stat) so symlinks are NOT followed. A support bundle
  // is untrusted input — it's extracted from a tarball, and tar preserves
  // symlinks. A malicious bundle could ship `logs-local/core-…-r0.log` as a
  // symlink to `/etc/shadow` or `~/.ssh/id_rsa`; stat() would follow it, report
  // isFile()===true, and the file readers (which open `absPath` directly) would
  // stream the target into the model context/report. lstat reports a symlink as
  // isFile()===false, so it is excluded here — the bundle-root confinement holds
  // for every read path, not just the one that calls resolve().
  const settled = await Promise.all(
    relPaths.map(async (rel): Promise<FileIndexEntry | null> => {
      const relPath = rel.split("\\").join("/"); // normalize Windows separators
      const absPath = join(rootDir, rel);
      try {
        const s = await lstat(absPath);
        if (s.isSymbolicLink() || !s.isFile()) return null;
        const c = classifyFile(relPath);
        return {
          relPath,
          absPath,
          kind: c.kind,
          ...(c.rank !== undefined ? { rank: c.rank } : {}),
          ...(c.service !== undefined ? { service: c.service } : {}),
          ...(c.host !== undefined ? { host: c.host } : {}),
          ...(c.component !== undefined ? { component: c.component } : {}),
          sizeBytes: s.size,
        };
      } catch {
        return null;
      }
    }),
  );

  return settled
    .filter((e): e is FileIndexEntry => e !== null)
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}
