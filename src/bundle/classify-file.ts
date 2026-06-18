/**
 * classify-file — map a bundle-relative path to a diagnostic file kind.
 *
 * A gpudb_sysinfo bundle mixes several artifact families. Tools need to know,
 * for any given path, what they're looking at and which rank/host/component it
 * belongs to. This classifier encodes the layout observed in real bundles:
 *
 *   logs-local/core-gpudb-rolling-r0.log   → core-log   (rank r0; the primary source)
 *   logs-local/sql-engine.log              → component-log (component "sql-engine")
 *   logs/gpudb.log                         → loki-tail  (last-2h Loki query, small)
 *   logs/rank2.log                         → loki-tail  (rank r2; Loki per-rank export)
 *   logs/hostmanager.log                   → loki-tail  (host-manager service; Loki export)
 *   gpudb_core_etc_gpudb.conf              → config
 *   mem.txt / cpu.txt / disk.txt / …       → os-diag
 *   gpudb-exe-r0-164100.txt                → process-info (rank r0)
 *   gpudb.txt                              → version-info
 *   errors.txt / logs-local/proc-logs-erros.txt → collection-errors (Evidence Gaps feed)
 *   logs-local/logfiles.txt                → manifest
 *
 * Pure, never throws.
 */

export type BundleFileKind =
  | "core-log"
  | "component-log"
  | "loki-tail"
  | "config"
  | "os-diag"
  | "process-info"
  | "version-info"
  | "collection-errors"
  | "manifest"
  | "unknown";

/** Cluster services that own logs/process captures but are NOT ranks. */
export type BundleService = "host-manager";

export interface FileClassification {
  readonly kind: BundleFileKind;
  /** Numeric rank the file belongs to ("r0", "r1", …). The host manager is NOT a rank — see `service`. */
  readonly rank?: string;
  /**
   * Non-rank cluster service the file belongs to. The host manager ("hm" in bundle
   * filenames) is a singleton service (port 9300), not a rank — keeping it out of
   * `rank` is what stops per-line rank filters and the inventory `ranks` list from
   * ever seeing a service name.
   */
  readonly service?: BundleService;
  /** Hostname inferred from the path (e.g. "node2"). */
  readonly host?: string;
  /** Component name for component logs (e.g. "sql-engine", "reveal", "tomcat"). */
  readonly component?: string;
}

// The "(r\d+|hm)" id in a rolling/exe filename is EITHER a numeric rank OR the
// host-manager service token. ROLLING/EXE_ID_RE captures it; rankOrService routes it.
// The optional `.\d+` tail matches log rotations (core-gpudb-rolling-r0.log.1) — older
// history for the same rank, kept searchable rather than dropped to `unknown`.
const ROLLING_ID_RE = /core-gpudb-rolling-(r\d+|hm)\.log(?:\.\d+)?$/;
const EXE_ID_RE = /gpudb-exe-(r\d+|hm)-/;
const HOST_RE = /\b(node\w+)\b/;

// A log file, possibly with a numeric rotation suffix: .log, .log.1, .log.2, …
const LOG_RE = /\.log(?:\.\d+)?$/;

// Loki-based collectors export one log per rank into logs/ as `rank<N>.log` (the
// ONLY evidence for ranks on hosts the collector didn't run on — those never appear
// in logs-local rolling files). `hostmanager.log` is the same export for the
// host-manager service. These carry rank/service identity in the filename and must
// be tagged so they're addressable, unlike the generic component tails under logs/.
const LOKI_RANK_RE = /^rank(\d+)\.log$/;
const LOKI_HM_BASE = "hostmanager.log";

/** Map a rolling/exe filename id to a rank XOR a service — never both. */
function rankOrService(id: string): { rank: string } | { service: BundleService } {
  return id === "hm" ? { service: "host-manager" } : { rank: id };
}

function basename(relPath: string): string {
  const parts = relPath.split("/");
  return parts[parts.length - 1] ?? relPath;
}

function dirOf(relPath: string): string {
  const parts = relPath.split("/");
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

function inferHost(relPath: string): string | undefined {
  return HOST_RE.exec(relPath)?.[1] ?? undefined;
}

function componentName(base: string): string {
  return (
    base
      // Strip a trailing rotation suffix first (tomcat.log.1 → tomcat.log), then ALL
      // trailing ".log" suffixes — real stats sub-logs ship doubled (e.g.
      // "stats-loki-node2.log.log"); stripping only one left ".log" glued to the name
      // and blocked the host-suffix strip below, so the component filter never matched.
      .replace(/\.\d+$/, "")
      .replace(/(\.log)+$/, "")
      .replace(/^core-gpudb-/, "")
      .replace(/^gpudb-/, "")
      .replace(/-node\w+$/, "")
  );
}

export function classifyFile(relPath: string): FileClassification {
  const base = basename(relPath);
  const dir = dirOf(relPath);
  const host = inferHost(relPath);

  if (base.endsWith(".conf")) {
    return { kind: "config", ...(host ? { host } : {}) };
  }

  if (base === "logfiles.txt") {
    return { kind: "manifest", ...(host ? { host } : {}) };
  }

  // Collection-failure summaries: the bundle's own `errors.txt` (exact) and the
  // real bundle's "erros" typo variant (e.g. logs-local/proc-logs-erros.txt).
  // Anchored deliberately: the correct spelling only matches as the exact
  // basename, so a prefixed data dump like `query-errors.txt` is NOT swept into
  // the Evidence-Gaps feed; only the misspelled `*erros.txt` is matched by suffix.
  if (base === "errors.txt" || base.endsWith("erros.txt")) {
    return { kind: "collection-errors", ...(host ? { host } : {}) };
  }

  if (base === "gpudb.txt") {
    return { kind: "version-info", ...(host ? { host } : {}) };
  }

  const exeId = EXE_ID_RE.exec(base);
  if (exeId) {
    return { kind: "process-info", ...rankOrService(exeId[1]), ...(host ? { host } : {}) };
  }

  if (LOG_RE.test(base)) {
    const rolling = ROLLING_ID_RE.exec(base);
    if (rolling) {
      return { kind: "core-log", ...rankOrService(rolling[1]), ...(host ? { host } : {}) };
    }
    // Loki tails live directly under logs/. Per-rank (`rank<N>.log`) and host-manager
    // (`hostmanager.log`) exports carry identity in the filename — tag them with
    // rank/service (NOT component) so per-rank selection and the inventory `ranks`
    // list pick them up. Everything else under logs/ is a component/service tail.
    if (dir === "logs") {
      // Normalize the Loki filename's identity to the shared "(r\d+|hm)" vocabulary so
      // the SAME rankOrService router used by rolling/exe files makes the rank-vs-service
      // decision — keeping that decision in one place. Filenames carry no token
      // (graph.log, sql.log) fall through to a component tail.
      const lokiRank = LOKI_RANK_RE.exec(base);
      const lokiId = lokiRank ? `r${lokiRank[1]}` : base === LOKI_HM_BASE ? "hm" : undefined;
      if (lokiId !== undefined) {
        return { kind: "loki-tail", ...rankOrService(lokiId), ...(host ? { host } : {}) };
      }
      return { kind: "loki-tail", component: componentName(base), ...(host ? { host } : {}) };
    }
    return { kind: "component-log", component: componentName(base), ...(host ? { host } : {}) };
  }

  if (base.endsWith(".txt")) {
    return { kind: "os-diag", ...(host ? { host } : {}) };
  }

  return { kind: "unknown", ...(host ? { host } : {}) };
}
