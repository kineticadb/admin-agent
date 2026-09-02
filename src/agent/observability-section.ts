/**
 * buildObservabilitySection — the Observability Capability block, shared by both prompt
 * builders. The bundle-only case matters: the stats stack is on a different host and
 * commonly outlives the cluster a bundle came from.
 *
 * Every claim is gated on the endpoint backing it — telling a Loki-only stack that
 * tier_snapshot is the first move costs the agent a wasted turn.
 *
 * Pure; "" when nothing is reachable.
 */

import { buildObservabilityEvidenceChecklist } from "../tools/observability/catalog.js";
import type { ObservabilityToolName } from "../tools/observability/catalog.js";
import type { ObservabilityClient } from "../observability/ObservabilityClient.js";

/** Backtick, matching the prompt builders' local convention. */
const t = "`";

/** Tools that only work with Prometheus, and the one that only works with Loki. */
const PROM_TOOLS: readonly ObservabilityToolName[] = [
  "kinetica_tier_snapshot",
  "kinetica_prom_query",
];
const LOKI_TOOLS: readonly ObservabilityToolName[] = ["kinetica_loki_query"];

/** Trap list for reading tier metrics correctly. Prometheus-only. */
function promTraps(): string {
  return `
**Reading tier metrics correctly** — these are the traps:
- Rank identity is the ${t}source${t} label (${t}rank0${t}, ${t}rank1${t}, …). There is no ${t}rank${t} label.
- ${t}size_bytes${t} is the tier **limit**, not the current size. A value of ${t}-1${t} means uncapped, so no percentage is meaningful.
- ${t}high_watermark${t}/${t}low_watermark${t} are **fractions** of the limit (commonly 0.9/0.8), not byte counts. Eviction begins at ${t}high_watermark x size_bytes${t}. Real headroom is the distance to that trigger, not ${t}limit - used${t}.
- ${t}evictions_total${t} is cumulative since process start — non-zero means it HAS evicted, not that it is evicting now.
- Rank 0 is the head node: it reports only ${t}size_bytes${t} and ${t}used_bytes${t}, with no watermarks or eviction counters. That is normal, not missing data.
- ${t}ki_db_tier${t} carries no user or table labels, so it can tell you a tier is under pressure but never WHO or WHAT caused it. Pair it with SQL against ${t}ki_catalog${t} or with ${t}kinetica_loki_query${t} ${t}class="sql"${t} for attribution.

**Prometheus is the running system; ${t}gpudb.conf${t} is only intent.** A config file states what was requested. ${t}kinetica_tier_snapshot${t} states what is actually enforced right now. When they disagree, the metric wins — and the disagreement is itself the finding (many settings take effect only after a restart).`;
}

/** What Loki actually holds. Loki-only. */
function lokiTraps(): string {
  return `
**Loki holds two populations, and ${t}stream${t} picks which.**
- ${t}stream="events"${t} (the default) — what the database pushes itself: ${t}class="sql"${t} (per-statement jobid, user, resource_group, elapsed, full statement), ${t}class="job"${t} (request failures with attribution), ${t}class="status"${t} (rank status transitions), ${t}class="config"${t}, ${t}class="mode"${t}. Always present.
- ${t}stream="logs"${t} — real rank log lines, but ONLY when the cluster has ${t}enable_promtail=true${t} (it is off by default, and turning it on in ${t}gpudb.conf${t} does nothing until the stats stack is restarted). When present this also reaches the SQL engine, graph, tomcat and workbench logs via ${t}job${t} — components no other live tool can see.

**Do not conclude "promtail is off" from an empty logs result alone.** Confirm with ${t}stream="events"${t}: events present and logs absent means promtail; both absent means the window or the selector.

**One vocabulary, whichever stream you read.** The two populations label the same things differently (${t}source${t}/${t}severity${t} for events, ${t}app${t}/${t}level${t} for logs, and the rank is spelled ${t}rank0${t} in one and ${t}rank-0${t} in the other). The tool translates, so always pass ${t}source="rank0"${t} — never reach for the raw label names unless you are writing a raw ${t}selector${t}.

**Promtail BACKFILLS on start; events do not.** Events are pushed live, so Loki has them only from the moment the database started emitting. Promtail instead tails the rolling log files from the beginning, so the moment it starts it ships whatever history those files still hold — measured on a live cluster, ~40 hours of log lines appeared instantly, reaching further back than the oldest event. Two consequences: an empty logs window does NOT mean promtail was off then, and enabling promtail during an incident recovers the log history that is still on disk rather than starting from zero.

**Promtail is line-oriented, so multi-line records are split.** A record whose value contains newlines — above all ${t}Executing SQL:${t} — arrives as a parent line plus continuation lines that land in a SEPARATE stream with no ${t}app${t} label and ingest-time timestamps, so they do not reliably pair back up. Report the first line as the first line, never as the whole statement. Complete multi-line SQL and contiguous stack traces exist only in a support bundle's rolling logs.`;
}

/**
 * Build the Observability Capability section.
 *
 * @param observability - the session's client, or undefined when none was reachable
 * @param context - "live" when a database connection exists, "bundle" for offline-only
 */
export function buildObservabilitySection(
  observability: ObservabilityClient | undefined,
  context: "live" | "bundle" = "live",
): string {
  const hasProm = Boolean(observability?.promUrl);
  const hasLoki = Boolean(observability?.lokiUrl);
  if (!hasProm && !hasLoki) return "";

  const available = [...(hasProm ? PROM_TOOLS : []), ...(hasLoki ? LOKI_TOOLS : [])];
  const services = [
    hasProm ? "**Prometheus** (metrics over time)" : "",
    hasLoki ? "**Loki** (structured events, plus rank log lines when promtail is on)" : "",
  ]
    .filter(Boolean)
    .join(" and ");

  const framing =
    context === "bundle"
      ? `The database itself is unreachable, but the stats stack runs on a **separate host** and is still answering: ${services}. It very likely holds metrics and events from the incident this bundle was captured for — use it to establish WHEN things changed, then corroborate with the bundle's logs.`
      : `This cluster exposes a live stats stack: ${services}. It runs on a **separate host** from the database, so it stays up — and keeps its history — even when the database does not.`;

  const firstMove = hasProm
    ? `**Round 1 should include ${t}kinetica_tier_snapshot${t}** — it covers every rank in one call and is the cheapest way to see whether the problem is resource pressure at all.`
    : `**Prometheus is not reachable in this session**, so there are no metrics: do not reach for tier or host statistics. ${t}kinetica_loki_query${t} is the only observability tool available.`;

  return `
---

## Observability Capability

${framing}

${buildObservabilityEvidenceChecklist(available)}

**Ask the retention question first.** Every source here has a horizon: Loki keeps hours to days; ${t}ki_query_history${t} is trimmed; the rolling logs hold roughly two weeks but live only in a support bundle. Before planning an investigation into something that happened N days ago, establish whether any source still has it. Proposing a search that cannot succeed wastes the operator's time.
${hasProm ? promTraps() : ""}${hasLoki ? lokiTraps() : ""}

${firstMove}`;
}
