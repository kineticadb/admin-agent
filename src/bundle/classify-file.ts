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
const ROLLING_ID_RE = /core-gpudb-rolling-(r\d+|hm)\.log$/;
const EXE_ID_RE = /gpudb-exe-(r\d+|hm)-/;
const HOST_RE = /\b(node\w+)\b/;

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
      // Strip ALL trailing ".log" suffixes — real stats sub-logs ship doubled (e.g.
      // "stats-loki-node2.log.log"); stripping only one left ".log" glued to the name
      // and blocked the host-suffix strip below, so the component filter never matched.
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

  if (base.endsWith(".log")) {
    const rolling = ROLLING_ID_RE.exec(base);
    if (rolling) {
      return { kind: "core-log", ...rankOrService(rolling[1]), ...(host ? { host } : {}) };
    }
    // Small last-2h Loki tails live directly under logs/.
    if (dir === "logs") {
      return { kind: "loki-tail", component: componentName(base), ...(host ? { host } : {}) };
    }
    return { kind: "component-log", component: componentName(base), ...(host ? { host } : {}) };
  }

  if (base.endsWith(".txt")) {
    return { kind: "os-diag", ...(host ? { host } : {}) };
  }

  return { kind: "unknown", ...(host ? { host } : {}) };
}
