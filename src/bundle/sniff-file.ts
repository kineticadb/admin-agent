/**
 * sniff-file — content-based classification fallback for files the PATH classifier
 * could not confidently place.
 *
 * classify-file is pure on the path string: fast, fully testable, but blind to files
 * whose NAME gives nothing away (a generic `.out`, a renamed log, a config with an odd
 * extension, a sysinfo capture in an unfamiliar bundle). This module reads a bounded
 * HEAD of such a file and test-drives the bundle's existing parsers against it —
 * whichever one bites tells us the kind. This is the "can we apply our parsers" half
 * of off-shape bundle support.
 *
 * Bounded and defensive by construction:
 *  - reads at most `headBytes` (default 8 KB), NEVER the whole file (a rank log is ~20 MB)
 *  - scans only the first `maxLines` non-blank lines — real logs can open with a non-log
 *    preamble (host-manager `.out` starts with "CPU ARCH: …" before the log lines), so
 *    checking only line 1 would miss them
 *  - never throws: any read/parse failure yields `undefined`, and the caller keeps the
 *    path classification
 *
 * The only side effect is a bounded read of `absPath`. Returns `undefined` when nothing
 * matches, so a caller only ever UPGRADES a weak/unknown path classification — never
 * downgrades a confident one.
 */

import { open } from "node:fs/promises";
import type { BundleFileKind, BundleService } from "./classify-file.js";
import { parseLogLine, severityRank } from "./parse-log-line.js";
import { unwrapLokiJsonl } from "./unwrap-loki-jsonl.js";
import { parseIni, SECTION_RE } from "./parse-ini.js";
import { EXEC_CMD_RE } from "./sysinfo-block.js";

export interface SniffResult {
  readonly kind: BundleFileKind;
  /** Why content sniffing chose this kind, e.g. "first log line parsed (FATAL, rank r0)". */
  readonly reason: string;
  readonly rank?: string;
  readonly service?: BundleService;
}

export const SNIFF_HEAD_BYTES = 8192;
export const SNIFF_MAX_LINES = 20;

/** Read at most `headBytes` of a file as UTF-8. Never throws — returns "" on any error. */
async function readHead(absPath: string, headBytes: number): Promise<string> {
  let fh;
  try {
    fh = await open(absPath, "r");
    const buf = Buffer.alloc(headBytes);
    const { bytesRead } = await fh.read(buf, 0, headBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return "";
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** Refine an EXEC_CMD sysinfo artifact by what the captured command did. */
function refineSysinfoKind(command: string): { kind: BundleFileKind; detail: string } {
  const cmd = command.toLowerCase();
  if (/-v\b|--version|\bgpudb_logger\b/.test(cmd) && cmd.includes("gpudb")) {
    return { kind: "version-info", detail: "version command" };
  }
  if (/\bps\b|\/proc\/|environ|grep .*gpudb/.test(cmd)) {
    return { kind: "process-info", detail: "process snapshot command" };
  }
  return { kind: "os-diag", detail: "host-diagnostic command" };
}

/** Map a parsed log line's rank/context to a kind + identity. */
function logLineResult(rank: string | undefined, severity: string, isHm: boolean): SniffResult {
  if (rank !== undefined) {
    return { kind: "core-log", reason: `log line parsed (${severity}, rank ${rank})`, rank };
  }
  if (isHm) {
    return {
      kind: "component-log",
      reason: `log line parsed (${severity}, host-manager)`,
      service: "host-manager",
    };
  }
  return { kind: "component-log", reason: `log line parsed (${severity})` };
}

export async function sniffFile(
  absPath: string,
  opts: { headBytes?: number; maxLines?: number } = {},
): Promise<SniffResult | undefined> {
  const headBytes = opts.headBytes ?? SNIFF_HEAD_BYTES;
  const maxLines = opts.maxLines ?? SNIFF_MAX_LINES;

  const text = await readHead(absPath, headBytes);
  if (text === "") return undefined;

  // First `maxLines` non-blank lines — the window every sniffer inspects.
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    lines.push(raw);
    if (lines.length >= maxLines) break;
  }
  if (lines.length === 0) return undefined;

  // 1. Sysinfo wrapper — the most specific signal. Authoritative even if log-like
  //    content follows, because the EXEC_CMD header frames the whole file.
  for (const line of lines) {
    const m = EXEC_CMD_RE.exec(line.trim());
    if (m) {
      const { kind, detail } = refineSysinfoKind(m[1]);
      return { kind, reason: `EXEC_CMD header (${detail})` };
    }
  }

  // 2. Loki/promtail JSONL export — the first non-blank line unwraps to a log line.
  const unwrapped = unwrapLokiJsonl(lines[0]);
  if (unwrapped !== undefined) {
    const p = parseLogLine(unwrapped);
    const rank = p.rank;
    return {
      kind: "loki-tail",
      reason: `Loki JSONL record${rank ? ` (rank ${rank})` : ""}`,
      ...(rank !== undefined ? { rank } : {}),
    };
  }

  // 3. Kinetica log line — any line in the window that parses with a known severity.
  //    (Scanning the window, not just line 1, catches logs behind a preamble.)
  for (const line of lines) {
    const p = parseLogLine(line);
    if (p.severity !== undefined && severityRank(p.severity) >= 0) {
      const isHm = p.context?.startsWith("hm/") ?? false;
      return logLineResult(p.rank, p.severity, isHm);
    }
  }

  // 4. INI/config — a `[section]` header plus parseable entries, and (by virtue of
  //    reaching here) no log severity. Conservative: require both signals so a stray
  //    `key=value` in prose is not mistaken for a config file.
  const hasSection = lines.some((l) => SECTION_RE.test(l.trim()));
  if (hasSection && parseIni(text).length >= 2) {
    return { kind: "config", reason: "INI section + key/value entries" };
  }

  return undefined;
}
