/**
 * BundleSource — the read-only data source for offline bundle mode.
 *
 * Analogous to KineticaSession for live mode: it's the single object the bundle
 * tools talk to. It owns the file index (built once at construction) and exposes
 * focused, bounded read operations over the bundle:
 *
 *   listFiles()        inventory (kinds, ranks, sizes)
 *   detectVersion()    GPUdb version from gpudb.txt, falling back to gpudb.conf
 *   readConfig()       gpudb.conf entries, filterable by section/key
 *   readSysinfo(name)  EXEC_CMD blocks of an OS-diag / process / version file
 *   searchLogs(query)  streaming search across selected log files
 *   logTimeline(query) per-time-bucket severity counts across selected logs
 *   collectionErrors() FAILED collection commands (Evidence Gaps feed)
 *
 * All file access is confined to the bundle root: resolve() rejects paths that
 * escape it. Read methods degrade to an `error` field rather than throwing.
 */

import { readFile } from "node:fs/promises";
import { resolve as resolvePath, sep } from "node:path";
import { parseSysinfo, type ParsedSysinfo } from "./sysinfo-block.js";
import { parseIni, filterIni, type IniEntry } from "./parse-ini.js";
import {
  searchLogFile,
  aggregateTimeline,
  DEFAULT_MAX_MATCHES,
  type LogQuery,
  type LogMatch,
  type TimelineQuery,
  type TimelineBucket,
} from "./log-search.js";
import { buildIndex, type FileIndexEntry } from "./bundle-index.js";

const GPUDB_VERSION_RE = /GPUdb version\s*:\s*(\S+)/;

/** A log-file selector layered on top of the raw log query. */
export interface BundleLogQuery extends LogQuery {
  /**
   * Restrict the file set to a numeric rank ("r0", "r1", … "r8"). Resolves to the
   * rank's rolling core log if present, else its Loki per-rank tail (logs/rank<N>.log).
   * This is a FILE selector only — each rank writes its own log, so it is not
   * re-applied per line (that would drop continuation/stack-trace lines that carry no
   * rank token). The host manager is a service, not a rank — select it with
   * `hostManager`, not here.
   */
  readonly rank?: string;
  /** Restrict the file set to the host-manager log (the "hm" singleton service, not a rank). */
  readonly hostManager?: boolean;
  /** Restrict the file set to a component log (e.g. "sql-engine"). */
  readonly component?: string;
  /** Include component logs in the default file set (default false → core logs only). */
  readonly includeComponents?: boolean;
}

export interface BundleLogMatch extends LogMatch {
  /** Bundle-relative path the match came from. */
  readonly file: string;
}

export interface BundleLogSearchResult {
  readonly matches: readonly BundleLogMatch[];
  readonly totalMatched: number;
  readonly linesScanned: number;
  readonly filesScanned: readonly string[];
  readonly capped: boolean;
}

export interface BundleTimelineResult {
  readonly buckets: readonly TimelineBucket[];
  readonly linesScanned: number;
  readonly totalCounted: number;
  readonly filesScanned: readonly string[];
}

export interface ConfigReadResult {
  readonly entries: readonly IniEntry[];
  readonly file: string;
}

/** Aggregate counts derived from the file index — the single source for inventory. */
export interface BundleInventory {
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly byKind: Readonly<Record<string, number>>;
  /** Numeric ranks present ("r0", "r1", …) — never includes non-rank services like the host manager. */
  readonly ranks: readonly string[];
  /** Non-rank cluster services whose logs/captures are present (e.g. "host-manager"). */
  readonly services: readonly string[];
}

export interface BundleSource {
  readonly root: string;
  listFiles(): readonly FileIndexEntry[];
  /** Aggregate inventory (file/byte counts, kinds, ranks). Derived once from the index. */
  inventory(): BundleInventory;
  resolve(relPath: string): string | undefined;
  detectVersion(): Promise<string | undefined>;
  readConfig(opts?: {
    section?: string;
    key?: string;
  }): Promise<ConfigReadResult | { error: string }>;
  readSysinfo(name: string): Promise<ParsedSysinfo | { error: string }>;
  searchLogs(query: BundleLogQuery): Promise<BundleLogSearchResult>;
  logTimeline(query: BundleTimelineQuery): Promise<BundleTimelineResult>;
  collectionErrors(): Promise<readonly string[]>;
}

export interface BundleTimelineQuery extends TimelineQuery {
  /** Restrict the file set to the host-manager log (a service, not a rank). */
  readonly hostManager?: boolean;
  readonly component?: string;
  readonly includeComponents?: boolean;
}

function selectLogFiles(
  index: readonly FileIndexEntry[],
  opts: { rank?: string; hostManager?: boolean; component?: string; includeComponents?: boolean },
): readonly FileIndexEntry[] {
  if (opts.component !== undefined) {
    // Component tails live in BOTH families: logs-local/<name>.log (component-log) and
    // the Loki export logs/<name>.log (loki-tail with a component name, e.g. graph, sql,
    // tomcat). Match either kind so a `component:` query reaches the Loki tails too —
    // otherwise large component logs under logs/ (graph.log can be tens of MB) are
    // indexed but unreachable whenever any core log exists.
    return index.filter(
      (e) =>
        (e.kind === "component-log" || e.kind === "loki-tail") && e.component === opts.component,
    );
  }
  // The host manager is a singleton service, selected explicitly — never via `rank`.
  // Prefer its rolling core log; fall back to its Loki tail (logs/hostmanager.log)
  // when no rolling log was collected — same core-beats-tail rule applied per rank below.
  if (opts.hostManager) {
    const hmCore = index.filter((e) => e.kind === "core-log" && e.service === "host-manager");
    if (hmCore.length > 0) return hmCore;
    return index.filter((e) => e.kind === "loki-tail" && e.service === "host-manager");
  }

  const matchesRank = (e: FileIndexEntry): boolean =>
    opts.rank === undefined || e.rank === opts.rank;

  // Per-rank precedence — NOT a global core-XOR-tails toggle. A rolling core log
  // (logs-local, full history) supersedes the Loki per-rank tail (logs/rank<N>.log)
  // FOR THE SAME RANK. But a Loki collector exports one tail per rank cluster-wide,
  // while logs-local only holds the ranks on the collector's own host — so ranks
  // present ONLY as tails (workers on other hosts) must still be selected. The old
  // global toggle ("if any core log exists, ignore all tails") silently dropped
  // exactly those ranks: the agent saw only r0/r1 and missed r2..rN entirely.
  const coreLogs = index.filter((e) => e.kind === "core-log" && matchesRank(e));
  const ranksWithCore = new Set(
    coreLogs.map((e) => e.rank).filter((r): r is string => r !== undefined),
  );
  const supplementalTails = index.filter(
    (e) =>
      e.kind === "loki-tail" &&
      e.rank !== undefined &&
      matchesRank(e) &&
      !ranksWithCore.has(e.rank),
  );
  const rankBearing = [...coreLogs, ...supplementalTails];

  // Last-resort fallback: a bundle with NO rank-bearing logs at all — neither
  // rolling core nor per-rank Loki tails. The only log evidence is the rank-less
  // tails (e.g. logs/gpudb.log). Without this the agent scans zero files and
  // wrongly concludes "no errors in logs". Honors the rank filter, so a rank-scoped
  // query against a bundle that lacks that rank correctly returns nothing.
  const core =
    rankBearing.length > 0
      ? rankBearing
      : index.filter((e) => e.kind === "loki-tail" && matchesRank(e));
  if (opts.includeComponents) {
    return [...core, ...index.filter((e) => e.kind === "component-log")];
  }
  return core;
}

// Rank/service/component are FILE selectors, resolved once by selectLogFiles. These
// project a bundle query down to ONLY its per-line filters, so the streaming searcher
// never re-applies a file selector per line. That redundant re-filter is what made
// rank:"hm" return nothing (host-manager lines carry no r\d+ token) and would drop
// continuation/stack-trace lines (no rank token) from a rank-scoped search. Explicit
// allow-list, not a strip-list: a future file selector can't accidentally leak through.
function toLineQuery(q: BundleLogQuery): LogQuery {
  return {
    ...(q.regex !== undefined ? { regex: q.regex } : {}),
    ...(q.caseSensitive !== undefined ? { caseSensitive: q.caseSensitive } : {}),
    ...(q.minSeverity !== undefined ? { minSeverity: q.minSeverity } : {}),
    ...(q.fromTs !== undefined ? { fromTs: q.fromTs } : {}),
    ...(q.toTs !== undefined ? { toTs: q.toTs } : {}),
    ...(q.maxMatches !== undefined ? { maxMatches: q.maxMatches } : {}),
  };
}

function toTimelineLineQuery(q: BundleTimelineQuery): TimelineQuery {
  return {
    ...(q.minSeverity !== undefined ? { minSeverity: q.minSeverity } : {}),
    ...(q.granularity !== undefined ? { granularity: q.granularity } : {}),
  };
}

export async function createBundleSource(rootDir: string): Promise<BundleSource> {
  const root = resolvePath(rootDir);
  const index = await buildIndex(root);

  const resolve = (relPath: string): string | undefined => {
    const abs = resolvePath(root, relPath);
    // Confine to the bundle root — reject `..` escapes and absolute breakouts.
    if (abs !== root && !abs.startsWith(root + sep)) return undefined;
    return abs;
  };

  const findByKind = (kind: FileIndexEntry["kind"]): FileIndexEntry | undefined =>
    index.find((e) => e.kind === kind);

  // Computed once at construction — the index is immutable for the source's lifetime.
  const inventoryValue: BundleInventory = (() => {
    const byKind: Record<string, number> = {};
    const rankSet = new Set<string>();
    const serviceSet = new Set<string>();
    let totalBytes = 0;
    for (const e of index) {
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      totalBytes += e.sizeBytes;
      if (e.rank) rankSet.add(e.rank);
      if (e.service) serviceSet.add(e.service);
    }
    return {
      totalFiles: index.length,
      totalBytes,
      byKind,
      ranks: [...rankSet].sort(),
      services: [...serviceSet].sort(),
    };
  })();

  const detectVersion = async (): Promise<string | undefined> => {
    const versionFile = findByKind("version-info");
    if (versionFile) {
      try {
        const parsed = parseSysinfo(await readFile(versionFile.absPath, "utf-8"));
        for (const block of parsed.blocks) {
          const m = GPUDB_VERSION_RE.exec(block.output);
          if (m) return m[1];
        }
      } catch {
        /* fall through to config */
      }
    }
    const configFile = findByKind("config");
    if (configFile) {
      try {
        const entries = parseIni(await readFile(configFile.absPath, "utf-8"));
        return entries.find((e) => e.key === "file_version")?.value;
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  const readConfig: BundleSource["readConfig"] = async (opts = {}) => {
    const configFile =
      index.find((e) => e.kind === "config" && e.relPath.endsWith("gpudb.conf")) ??
      findByKind("config");
    if (!configFile) return { error: "no gpudb.conf found in bundle" };
    try {
      const entries = parseIni(await readFile(configFile.absPath, "utf-8"));
      return { entries: filterIni(entries, opts), file: configFile.relPath };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const readSysinfo: BundleSource["readSysinfo"] = async (name) => {
    const entry = index.find(
      (e) =>
        e.relPath === name || e.relPath.endsWith("/" + name) || e.relPath.split("/").pop() === name,
    );
    if (!entry) return { error: `no bundle file named "${name}"` };
    const abs = resolve(entry.relPath);
    if (!abs) return { error: `path "${name}" escapes the bundle root` };
    try {
      return parseSysinfo(await readFile(abs, "utf-8"));
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const searchLogs: BundleSource["searchLogs"] = async (query) => {
    const files = selectLogFiles(index, query);
    // Rank/service were resolved at the file level above; pass only per-line filters down.
    const lineQuery = toLineQuery(query);
    const matches: BundleLogMatch[] = [];
    const filesScanned: string[] = [];
    let totalMatched = 0;
    let linesScanned = 0;
    // `maxMatches` caps the returned match PAYLOADS (so a broad search can't flood
    // the context), NOT the count or the file set. The budget is shared across files:
    // once it's spent we keep scanning with maxMatches:0 — searchLogFile still streams
    // the whole file and counts totalMatched/linesScanned, it just stops collecting
    // lines. This mirrors logTimeline (which always scans every selected file) and is
    // what makes totalMatched a TRUE total and `capped` honest. The earlier early-break
    // left totalMatched a lower bound and could set capped=true when nothing was
    // actually dropped — an agent then mistook a multi-rank incident for r0-only.
    const maxMatches = query.maxMatches ?? DEFAULT_MAX_MATCHES;

    for (const file of files) {
      const remaining = Math.max(0, maxMatches - matches.length);
      const r = await searchLogFile(file.absPath, { ...lineQuery, maxMatches: remaining });
      filesScanned.push(file.relPath);
      totalMatched += r.totalMatched;
      linesScanned += r.linesScanned;
      for (const m of r.matches) matches.push({ ...m, file: file.relPath });
    }

    // capped iff more lines matched than were returned — accurate now that every
    // selected file was scanned (no false positive when the cap is met exactly).
    return {
      matches,
      totalMatched,
      linesScanned,
      filesScanned,
      capped: totalMatched > matches.length,
    };
  };

  const logTimeline: BundleSource["logTimeline"] = async (query) => {
    const files = selectLogFiles(index, query);
    // File selectors resolved above; aggregate by only the per-line filters.
    const lineQuery = toTimelineLineQuery(query);
    const merged = new Map<string, Record<string, number>>();
    const filesScanned: string[] = [];
    let linesScanned = 0;
    let totalCounted = 0;

    for (const file of files) {
      const r = await aggregateTimeline(file.absPath, lineQuery);
      filesScanned.push(file.relPath);
      linesScanned += r.linesScanned;
      totalCounted += r.totalCounted;
      for (const b of r.buckets) {
        const existing = merged.get(b.bucket) ?? {};
        for (const [sev, n] of Object.entries(b.counts)) existing[sev] = (existing[sev] ?? 0) + n;
        merged.set(b.bucket, existing);
      }
    }

    const buckets: TimelineBucket[] = [...merged.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bucket, counts]) => ({
        bucket,
        counts,
        total: Object.values(counts).reduce((x, y) => x + y, 0),
      }));

    return { buckets, linesScanned, totalCounted, filesScanned };
  };

  const collectionErrors = async (): Promise<readonly string[]> => {
    const files = index.filter((e) => e.kind === "collection-errors");
    const lines: string[] = [];
    for (const file of files) {
      try {
        const content = await readFile(file.absPath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (trimmed !== "" && !/^-{3,}$/.test(trimmed)) lines.push(trimmed);
        }
      } catch {
        /* skip unreadable error file */
      }
    }
    return lines;
  };

  return {
    root,
    listFiles: () => index,
    inventory: () => inventoryValue,
    resolve,
    detectVersion,
    readConfig,
    readSysinfo,
    searchLogs,
    logTimeline,
    collectionErrors,
  };
}
