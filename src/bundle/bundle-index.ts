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

import { readdir, lstat, realpath } from "node:fs/promises";
import { join, sep, dirname } from "node:path";
import {
  classifyFile,
  type BundleFileKind,
  type ClassifyConfidence,
  type FileClassification,
} from "./classify-file.js";
import { sniffFile } from "./sniff-file.js";

export interface FileIndexEntry {
  /** Path relative to the bundle root, using "/" separators. */
  readonly relPath: string;
  /** Absolute path on disk. */
  readonly absPath: string;
  readonly kind: BundleFileKind;
  /** How the kind was determined (exact | inferred | weak) — surfaced by orientation tools. */
  readonly confidence: ClassifyConfidence;
  /** Short explanation of why this kind was chosen. */
  readonly reason?: string;
  /** Numeric rank ("r0", "r1", …). The host manager is NOT a rank — see `service`. */
  readonly rank?: string;
  /** True when `rank` came from a loose heuristic rather than a canonical pattern. */
  readonly inferredRank?: boolean;
  /** Non-rank cluster service the file belongs to (e.g. "host-manager"). */
  readonly service?: string;
  readonly host?: string;
  readonly component?: string;
  readonly sizeBytes: number;
}

/**
 * When the path classifier was unsure (weak confidence), refine with content
 * sniffing — but only ADOPT the sniff when it adds information (a different kind,
 * or a rank/service the path lacked). The high-value targets are files with
 * uninformative names: `unknown`, and weak log-like files (a renamed log, an odd
 * extension). A weak `os-diag` (.txt) is skipped entirely — the extension already
 * routed it to the right bucket and the sniffer can only ever re-derive os-diag for
 * it, so reading its head would be ~20 discarded I/O round-trips on a normal bundle.
 *
 * Never throws — a sniff failure leaves the path classification intact.
 */
async function refineWithContent(
  c: FileClassification,
  absPath: string,
): Promise<FileClassification> {
  if (c.confidence !== "weak" || c.kind === "os-diag") return c;
  const sniff = await sniffFile(absPath);
  if (!sniff) return c;

  const addsKind = sniff.kind !== c.kind;
  const addsRank = sniff.rank !== undefined && c.rank === undefined;
  const addsService = sniff.service !== undefined && c.service === undefined;
  if (!addsKind && !addsRank && !addsService) return c;

  // Spread the path classification and override only what content settled. A weak entry
  // never carries `inferredRank`, so carrying it over is unnecessary; a content-derived
  // rank (from the log line's (pid,tid,rN/…) context) is authoritative and replaces it
  // WITHOUT the inferredRank flag — it belongs in the trusted rank count. The OVERALL
  // confidence becomes "inferred": identity settled by content, not a canonical name.
  return {
    ...c,
    kind: sniff.kind,
    confidence: "inferred",
    reason: `content: ${sniff.reason}`,
    ...(sniff.rank !== undefined ? { rank: sniff.rank } : {}),
    ...(sniff.service !== undefined ? { service: sniff.service } : {}),
  };
}

export async function buildIndex(rootDir: string): Promise<readonly FileIndexEntry[]> {
  let relPaths: string[];
  let realRoot: string;
  try {
    relPaths = await readdir(rootDir, { recursive: true });
    // Resolve the bundle root's OWN symlinks once, so each entry can be confined
    // against the canonical root. The root itself is frequently symlinked (on macOS
    // /tmp → /private/tmp, and mkdtemp lands under it) — a lexical compare against
    // the un-resolved rootDir would then reject every legitimate file.
    realRoot = await realpath(rootDir);
  } catch {
    return [];
  }

  // Confining an entry means resolving its real path against realRoot — but realpath()
  // re-resolves EVERY ancestor component on each call, so doing it per file re-resolves a
  // directory's shared chain once per sibling (a rank's logs-local can hold thousands of
  // files). Instead resolve each distinct PARENT directory once and memoize the verdict:
  // a non-symlink leaf (guaranteed by the lstat check below) under a confined directory is
  // itself confined, so the parent's verdict is sufficient. Cache the in-flight PROMISE,
  // not the resolved boolean, so concurrent siblings of the same directory share a single
  // realpath() instead of racing to compute the same answer.
  const dirConfined = new Map<string, Promise<boolean>>();
  const isDirConfined = (dir: string): Promise<boolean> => {
    let verdict = dirConfined.get(dir);
    if (verdict === undefined) {
      verdict = realpath(dir).then(
        (realDir) => realDir === realRoot || realDir.startsWith(realRoot + sep),
        () => false, // an unresolvable directory (broken/cyclic symlink) → drop its entries
      );
      dirConfined.set(dir, verdict);
    }
    return verdict;
  };

  // Stat every entry concurrently rather than awaiting one at a time. A real
  // bundle has thousands of files; a sequential await-in-loop serializes that
  // many round-trips (cheap on local disk, seconds on a network/FUSE mount).
  // Promise.all lets libuv's threadpool overlap them. Directories, symlinks, and
  // unreadable entries resolve to null and are filtered out.
  //
  // SECURITY: a support bundle is untrusted input — extracted from a tarball, and
  // tar preserves symlinks. Confinement to the bundle root has TWO layers, both
  // enforced here BEFORE any byte is read:
  //
  //   1. lstat (not stat) so a LEAF symlink is not followed. A bundle shipping
  //      `logs-local/core-…-r0.log` as a symlink to /etc/shadow or ~/.ssh/id_rsa
  //      reports isSymbolicLink()===true and is excluded.
  //   2. realpath confinement against a symlinked PARENT directory. readdir(recursive)
  //      descends THROUGH a symlinked directory and yields the real files inside the
  //      target — whose leaf lstat reports isSymbolicLink()===false, isFile()===true,
  //      slipping past layer 1. So `logs-local → $HOME` would otherwise smuggle
  //      ~/.ssh/id_rsa into the index. We resolve the entry's PARENT directory's real
  //      path (memoized per directory — see isDirConfined) and drop the entry unless it
  //      stays under realRoot; that suffices because layer 1 already proved the leaf is
  //      not a symlink, so it cannot escape a confined parent. (A lexical `..` check
  //      can't catch this — the escaping path is lexically inside the root; only realpath
  //      reveals the escape.)
  //
  // Without this, every downstream reader (searchLogFile, readConfig, sniffFile, …)
  // opens `absPath` directly and would stream the escaped target into the model
  // context/report. One check here covers ALL of them because the index is the single
  // chokepoint they read from.
  const settled = await Promise.all(
    relPaths.map(async (rel): Promise<FileIndexEntry | null> => {
      const relPath = rel.split("\\").join("/"); // normalize Windows separators
      const absPath = join(rootDir, rel);
      try {
        const s = await lstat(absPath);
        if (s.isSymbolicLink() || !s.isFile()) return null;
        // Layer 2: confine via the entry's PARENT directory (memoized), defeating a
        // symlinked parent. The leaf is already known not to be a symlink (layer 1), so a
        // confined parent means a confined file. Done before refineWithContent/sniffFile
        // reads any byte, so the no-escape invariant holds for the very first read.
        if (!(await isDirConfined(dirname(absPath)))) return null;
        // Path classification first (pure); content sniffing only refines weak results.
        const c = await refineWithContent(classifyFile(relPath), absPath);
        return {
          relPath,
          absPath,
          kind: c.kind,
          confidence: c.confidence,
          ...(c.reason !== undefined ? { reason: c.reason } : {}),
          ...(c.rank !== undefined ? { rank: c.rank } : {}),
          ...(c.inferredRank !== undefined ? { inferredRank: c.inferredRank } : {}),
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
