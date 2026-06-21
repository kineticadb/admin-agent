/**
 * classify-file — map a bundle-relative path to a diagnostic file kind.
 *
 * A gpudb_sysinfo bundle mixes several artifact families. Tools need to know,
 * for any given path, what they're looking at and which rank/host/component it
 * belongs to. But not every bundle matches the canonical collector layout — a
 * customer may hand over a logs-only dump, a differently-named collector's
 * output, or a flat directory. So classification is TIERED, and every result
 * carries a `confidence` so callers (and the agent) can tell a recognized
 * canonical file from a best-effort inference:
 *
 *   exact     — matched a canonical gpudb_sysinfo name/location, identity certain
 *   inferred  — matched a generalized name/extension heuristic (off-shape bundle)
 *   weak      — extension-only fallback (we know little beyond "a .txt"/"a .log")
 *
 * Canonical layout (→ exact):
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
 * Off-shape layout (→ inferred), e.g. a flat logs-only bundle ("<host>" below is an
 * arbitrary host token — incidental, never relied upon):
 *   gpudb-rolling-r3.log.2                 → core-log   (rank r3; no `core-` prefix, no logs-local dir)
 *   gpudb-rolling-hm.log                   → core-log   (host-manager service)
 *   gpudb-host-manager-<host>.out          → component-log (host-manager service stdout)
 *   gpudb-service-<host>.log / gpudb.log   → component-log (gpudb log, non-canonical location)
 *
 * Classification keys off the file's RELATIVE path (the bundle-root folder name is
 * stripped by the index walk) and, for the off-shape heuristics, off the BASENAME — so
 * the directory the bundle was extracted into, and whatever the customer named it, never
 * affect the result.
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

/** How sure we are of a classification — surfaced so an inferred guess never reads as certain. */
export type ClassifyConfidence = "exact" | "inferred" | "weak";

/** Cluster services that own logs/process captures but are NOT ranks. */
export type BundleService = "host-manager";

export interface FileClassification {
  readonly kind: BundleFileKind;
  /** How the kind was determined — see ClassifyConfidence. */
  readonly confidence: ClassifyConfidence;
  /** Short human-readable explanation of why this kind was chosen (for orientation tools). */
  readonly reason?: string;
  /** Numeric rank the file belongs to ("r0", "r1", …). The host manager is NOT a rank — see `service`. */
  readonly rank?: string;
  /**
   * True when `rank` came from a loose heuristic (a token in an unrecognized name)
   * rather than a canonical/rolling pattern. Lets the inventory keep heuristic ranks
   * out of the "trust this for the true rank count" list.
   */
  readonly inferredRank?: boolean;
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
// host-manager service token. The capture group routes through rankOrService.
//
// ROLLING: the `core-` prefix is OPTIONAL. The canonical collector writes
// `core-gpudb-rolling-r0.log`, but a logs-only dump ships the same file as
// `gpudb-rolling-r0.log`. A rolling log is semantically unambiguous either way, so
// both classify as core-log with the rank/service from the name. The optional
// `.\d+` tail matches rotations (…rolling-r0.log.1) — older history for the same rank.
const ROLLING_ID_RE = /(?:core-)?gpudb-rolling-(r\d+|hm)\.log(?:\.\d+)?$/;
const EXE_ID_RE = /gpudb-exe-(r\d+|hm)-/;
const HOST_RE = /\b(node\w+)\b/;

// Canonical config (exact) and config-like extensions (inferred).
const CONF_RE = /\.conf$/i;
const CONF_ALT_RE = /\.(cfg|ini)$/i;

// A canonical log file, possibly with a numeric rotation suffix: .log, .log.1, …
const LOG_RE = /\.log(?:\.\d+)?$/;
// A log-ish file in an off-shape bundle: also stdout/stderr captures (.out/.err),
// with an optional rotation suffix. Host-manager process logs ship as `.out`.
const LOGISH_RE = /\.(?:log|out|err)(?:\.\d+)?$/i;

// Loki-based collectors export one log per rank into logs/ as `rank<N>.log` (the
// ONLY evidence for ranks on hosts the collector didn't run on). `hostmanager.log`
// is the same export for the host-manager service. These carry rank/service identity
// in the filename and must be tagged so they're addressable.
const LOKI_RANK_RE = /^rank(\d+)\.log$/;
const LOKI_HM_BASE = "hostmanager.log";

// Off-shape signals.
const HM_TOKEN_RE = /host-?manager/i;
// A rank token loose enough to catch off-shape names (`rank0`, `rank_3`, `-r2-`, `r4/`)
// but anchored on word boundaries so it does not fire on arbitrary digits.
const RANK_TOKEN_RE = /(?:\brank[-_]?|\br)(\d{1,2})\b/i;
// The path passes through (or sits inside) a directory named for logs.
const LOG_DIR_RE = /(?:^|\/)(?:logs|logs-local|log)(?:\/|$)/;

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
      // trailing log-ish suffixes — real stats sub-logs ship doubled (e.g.
      // "stats-loki-node2.log.log"), and host-manager stdout ships as ".out".
      .replace(/\.\d+$/, "")
      .replace(/(?:\.(?:log|out|err))+$/i, "")
      .replace(/^core-gpudb-/, "")
      .replace(/^gpudb-/, "")
      .replace(/-node\w+$/, "")
  );
}

interface Ctx {
  readonly relPath: string;
  readonly base: string;
  readonly dir: string;
  readonly host?: string;
}

/** Assemble a classification, omitting absent optional fields (immutable). */
function cls(
  kind: BundleFileKind,
  confidence: ClassifyConfidence,
  reason: string,
  parts: {
    rank?: string;
    inferredRank?: boolean;
    service?: BundleService;
    component?: string;
    host?: string;
  } = {},
): FileClassification {
  return {
    kind,
    confidence,
    reason,
    ...(parts.rank !== undefined ? { rank: parts.rank } : {}),
    ...(parts.inferredRank !== undefined ? { inferredRank: parts.inferredRank } : {}),
    ...(parts.service !== undefined ? { service: parts.service } : {}),
    ...(parts.component !== undefined ? { component: parts.component } : {}),
    ...(parts.host !== undefined ? { host: parts.host } : {}),
  };
}

// Ordered matchers — first non-null wins. Canonical (exact) rules run before the
// off-shape (inferred) heuristics, so a recognized bundle classifies identically to
// before; only files the canonical rules miss reach the heuristics. Tier-C fallbacks
// run last.
const MATCHERS: ReadonlyArray<(c: Ctx) => FileClassification | null> = [
  // ── Tier A: canonical filenames / locations (exact) ──────────────────────────
  (c) => (CONF_RE.test(c.base) ? cls("config", "exact", "config (.conf)", { host: c.host }) : null),
  (c) =>
    CONF_ALT_RE.test(c.base)
      ? cls("config", "inferred", "config-like extension (.cfg/.ini)", { host: c.host })
      : null,
  (c) =>
    c.base === "logfiles.txt"
      ? cls("manifest", "exact", "collector manifest", { host: c.host })
      : null,
  (c) =>
    c.base === "errors.txt" || c.base.endsWith("erros.txt")
      ? cls("collection-errors", "exact", "collection-errors summary", { host: c.host })
      : null,
  (c) =>
    c.base === "gpudb.txt" ? cls("version-info", "exact", "gpudb.txt", { host: c.host }) : null,
  (c) => {
    const m = EXE_ID_RE.exec(c.base);
    return m
      ? cls("process-info", "exact", "gpudb-exe process capture", {
          ...rankOrService(m[1]),
          host: c.host,
        })
      : null;
  },
  (c) => {
    const m = ROLLING_ID_RE.exec(c.base);
    if (!m) return null;
    const reason = c.base.startsWith("core-")
      ? "core rolling-log pattern"
      : "rolling-log pattern (no core- prefix)";
    return cls("core-log", "exact", reason, { ...rankOrService(m[1]), host: c.host });
  },
  (c) => {
    if (c.dir !== "logs" || !LOG_RE.test(c.base)) return null;
    const lr = LOKI_RANK_RE.exec(c.base);
    const lokiId = lr ? `r${lr[1]}` : c.base === LOKI_HM_BASE ? "hm" : undefined;
    return lokiId !== undefined
      ? cls("loki-tail", "exact", "Loki per-rank/host-manager export under logs/", {
          ...rankOrService(lokiId),
          host: c.host,
        })
      : cls("loki-tail", "exact", "Loki component tail under logs/", {
          component: componentName(c.base),
          host: c.host,
        });
  },
  (c) =>
    c.dir === "logs-local" && LOG_RE.test(c.base)
      ? cls("component-log", "exact", "component log under logs-local/", {
          component: componentName(c.base),
          host: c.host,
        })
      : null,

  // ── Tier B: off-shape name/extension heuristics (inferred) ───────────────────
  // Host-manager service logs in a flat layout: the rolling-hm log is already caught
  // above; this catches the service log and the process stdout (.out). This MUST come
  // before the generic gpudb-prefixed matcher below — both would classify a
  // `gpudb-host-manager-*.log` as a component-log, but only this one adds the
  // `service: "host-manager"` tag. Kept separate (not folded into the gpudb matcher) so
  // a host-manager log WITHOUT a gpudb prefix (e.g. a renamed `hostmanager-*.out`) still
  // gets the service tag rather than falling through to a plain component-log.
  (c) =>
    HM_TOKEN_RE.test(c.base) && LOGISH_RE.test(c.base)
      ? cls("component-log", "inferred", "host-manager service log (name match)", {
          service: "host-manager",
          component: componentName(c.base),
          host: c.host,
        })
      : null,
  // Any other gpudb-prefixed log-ish file in a non-canonical location.
  (c) =>
    (c.base.startsWith("gpudb") || c.base.startsWith("core-gpudb")) && LOGISH_RE.test(c.base)
      ? cls("component-log", "inferred", "gpudb log (name match, non-canonical location)", {
          component: componentName(c.base),
          host: c.host,
        })
      : null,
  // A log-ish file sitting in a log-named directory, or carrying a rank token.
  (c) => {
    if (!LOGISH_RE.test(c.base)) return null;
    const inLogDir = LOG_DIR_RE.test(c.relPath);
    const rm = RANK_TOKEN_RE.exec(c.base);
    if (!inLogDir && !rm) return null;
    const rank = rm ? `r${rm[1]}` : undefined;
    const reason = rank ? "log-like file with a rank token" : "log-like file in a log directory";
    return cls(c.dir === "logs" ? "loki-tail" : "component-log", "inferred", reason, {
      ...(rank !== undefined ? { rank, inferredRank: true } : { component: componentName(c.base) }),
      host: c.host,
    });
  },

  // ── Tier C: extension-only fallbacks (weak) ──────────────────────────────────
  (c) =>
    c.base.endsWith(".txt")
      ? cls("os-diag", "weak", "fallback: .txt extension", { host: c.host })
      : null,
  (c) =>
    LOGISH_RE.test(c.base)
      ? cls("component-log", "weak", "fallback: log-like extension", {
          component: componentName(c.base),
          host: c.host,
        })
      : null,
];

export function classifyFile(relPath: string): FileClassification {
  const base = basename(relPath);
  const dir = dirOf(relPath);
  const host = inferHost(relPath);
  const ctx: Ctx = { relPath, base, dir, ...(host !== undefined ? { host } : {}) };

  for (const matcher of MATCHERS) {
    const result = matcher(ctx);
    if (result) return result;
  }
  return cls("unknown", "weak", "unrecognized file", { host });
}
