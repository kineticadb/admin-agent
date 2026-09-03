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
import { OBSERVABILITY_TOOL_NAMES, TOOL_ENDPOINT } from "../tools/observability/index.js";
import type { ObservabilityClient } from "../observability/ObservabilityClient.js";

/** Backtick, matching the prompt builders' local convention. */
const t = "`";

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

**Prometheus is the running system; ${t}gpudb.conf${t} is only intent.** A config file states what was requested. ${t}kinetica_tier_snapshot${t} states what is actually enforced right now. When they disagree, the metric wins — and the disagreement is itself the finding (many settings take effect only after a restart).

**Use the site's OWN thresholds, never a generic figure.** ${t}kinetica_prom_alerts${t} returns each rule's ${t}expr${t} — this site's definition of "too high" — plus what is firing now. Cite that, or the enforced limit from ${t}kinetica_tier_snapshot${t}. What counts as high is per-customer, so a number you supply from general knowledge is a guess presented as a finding.
- **Zero configured rules is the ABSENCE of monitoring, not health** — and on a kagent-installed stack it is unexpected. A measured kagent install ships a Prometheus rule file covering host load, memory, disk, request concurrency and RabbitMQ HA queue depth, so an empty list there means those rules are missing or failed to load, NOT that nobody set a threshold. Either way never read it as "nothing is wrong"; report it as a monitoring gap in its own right.
- A rule whose ${t}health${t} is ${t}err${t} can never fire, so the subsystem it watches is unmonitored no matter how quiet it looks.
- **Read the ${t}for${t} column; never infer the dwell time from the rule name.** A name like ${t}mem90for5m${t} is just a label someone typed — it can disagree with the actual ${t}for${t}, which has been observed as ${t}0s${t} on such rules. When ${t}for${t} is ${t}0s${t} the rule fires on a single scrape, so firing does NOT mean "sustained" and flapping is expected. Cite the column, not the name.
- Kinetica's own alerts (${t}alert_memory_percentage${t}, ${t}alert_disk_percentage${t}, heartbeat) are pushed by the database straight to Alertmanager and do **not** appear in Prometheus. Read those with ${t}kinetica_cluster_status${t}. So "no Prometheus alert rules" does not mean the database is not alerting.`;
}

/** What Loki actually holds. Loki-only. */
function lokiTraps(): string {
  return `
**Loki holds two populations, and ${t}stream${t} picks which.**
- ${t}stream="events"${t} (the default) — what the database pushes itself: ${t}class="sql"${t} (per-statement jobid, user, resource_group, elapsed, full statement), ${t}class="job"${t} (request failures with attribution), ${t}class="status"${t} (rank status transitions), ${t}class="config"${t}, ${t}class="mode"${t}. Always present.
- ${t}stream="logs"${t} — the real rank log lines, and via ${t}job${t} the SQL engine, graph, tomcat and workbench logs no other live tool can see. Present when the cluster runs promtail. **Always run it and read the verdict** rather than deciding in advance whether it is available: the tool itself reports whether promtail is shipping, so asking costs one call and assuming costs the whole log dimension.

**Events are telemetry, NOT logs — you have not read any log lines until you run ${t}stream="logs"${t}.** The default stream returns what the database pushes about itself; it contains no log line, no stack trace and no component output. So a health check, an incident review, or any statement of the form "no errors in the logs" is incomplete until you have either read log lines or reported the promtail verdict that says none are being shipped. Silence in ${t}class="job"${t} events is not silence in the logs.

**Never conclude "promtail is off" yourself.** An empty ${t}stream="logs"${t} result reports what it verified — the tool probes Loki's label set and says whether promtail streams exist — so quote that, and if it says promtail IS shipping, the filter or window emptied the result. Comparing an empty logs result against a non-empty events one proves nothing: a ${t}severity${t}-filtered logs query returns empty on a healthy cluster with no errors. Confirm the setting itself — ${t}enable_promtail${t} in ${t}gpudb.conf${t}, which does nothing until the stats stack is restarted — with ${t}kinetica_show_configuration${t}, never by inference.

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

  // Filtered from the tuple, so row order is owned by OBSERVABILITY_TOOL_NAMES alone.
  const reachable = { prom: hasProm, loki: hasLoki };
  const available = OBSERVABILITY_TOOL_NAMES.filter((name) => reachable[TOOL_ENDPOINT[name]]);
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
    ? `**Round 1 should start with ${t}kinetica_prom_alerts${t}, then ${t}kinetica_tier_snapshot${t}.** The first tells you what this site's own monitoring is already flagging and what thresholds it holds — the cheapest possible orientation, and it may name the problem outright. The second covers every rank in one call and shows whether the problem is resource pressure at all.`
    : `**Prometheus is not reachable in this session**, so there are no metrics and no alert rules: do not reach for tier or host statistics, and do not claim the site's monitoring is quiet — you cannot see it. ${t}kinetica_loki_query${t} is the only observability tool available.`;

  return `
---

## Observability Capability

${framing}

${buildObservabilityEvidenceChecklist(available)}

**Ask the retention question first.** Every source here has a horizon: Loki keeps hours to days; ${t}ki_query_history${t} is trimmed; the rolling logs hold roughly two weeks but live only in a support bundle. Before planning an investigation into something that happened N days ago, establish whether any source still has it. Proposing a search that cannot succeed wastes the operator's time.
${hasProm ? promTraps() : ""}${hasLoki ? lokiTraps() : ""}

${firstMove}`;
}
