/**
 * Observability tool barrel — the Prometheus/Loki tools.
 *
 * Registered whether or not endpoints were discovered, mirroring the bundle tools: the
 * SDK fixes the tool set at query() creation, so a conditionally registered tool could
 * never appear. Without an endpoint they return a failure naming KINETICA_STATS_HOST.
 *
 * Every handler runs through applyOutputPipeline and is annotated readOnly — these are
 * unauthenticated GETs against read-only APIs.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";

import { createRegistry } from "../../approval/registry.js";
import type { Registry } from "../../approval/registry.js";
import { applyOutputPipeline } from "../index.js";
import type { ObservabilityClient } from "../../observability/ObservabilityClient.js";
import type { ToolResult } from "../../types/index.js";

import { promAlerts, PromAlertsSchema, type PromAlertsInput } from "./prom-alerts.js";
import { promQuery, PromQuerySchema, type PromQueryInput } from "./prom-query.js";
import { tierSnapshot, TierSnapshotSchema, type TierSnapshotInput } from "./tier-snapshot.js";
import { lokiQuery, LokiQuerySchema, type LokiQueryInput } from "./loki-query.js";

export const OBSERVABILITY_TOOL_NAMES = [
  "kinetica_prom_alerts",
  "kinetica_tier_snapshot",
  "kinetica_prom_query",
  "kinetica_loki_query",
] as const;

export type ObservabilityToolName = (typeof OBSERVABILITY_TOOL_NAMES)[number];

/** The two services the stats stack can expose, and how each is addressed. */
const ENDPOINTS = {
  prom: { urlKey: "promUrl", service: "Prometheus" },
  loki: { urlKey: "lokiUrl", service: "Loki" },
} as const satisfies Record<string, { urlKey: "promUrl" | "lokiUrl"; service: string }>;

/**
 * Which endpoint each tool needs — the ONE declaration of that fact.
 *
 * A full `Record`, so a tool cannot join OBSERVABILITY_TOOL_NAMES unclassified. It lives
 * here because two consumers must agree: `withClient()` gates the tool on the matching
 * URL, and `buildObservabilitySection()` decides whether to ADVERTISE it in the prompt.
 * Declared separately they could disagree, and neither would typecheck the other.
 */
export const TOOL_ENDPOINT: Readonly<Record<ObservabilityToolName, keyof typeof ENDPOINTS>> = {
  kinetica_prom_alerts: "prom",
  kinetica_tier_snapshot: "prom",
  kinetica_prom_query: "prom",
  kinetica_loki_query: "loki",
};

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/** Failure returned when no observability endpoint was discovered or supplied. */
function notConfigured(service: string): ToolResult<never> {
  return {
    ok: false,
    status: 0,
    error:
      `No ${service} endpoint is available for this session. On a kagent install the stats stack ` +
      `runs on the host named by gpudb.conf's gaia.event_server_address, which is often an ` +
      `internal address that does not route from here. Ask the operator to set ` +
      `KINETICA_STATS_HOST to a reachable hostname and restart, or continue without ${service}.`,
    raw: "",
  };
}

/**
 * Run a handler against the client, or return the not-configured failure.
 *
 * Checks the SPECIFIC endpoint the tool needs, not merely whether a client object
 * exists. A partial stack is common — discovery routinely reaches Loki but not
 * Prometheus, or vice versa — and testing only for the client would let a
 * Prometheus tool proceed on a Loki-only client, where it fails deep inside with
 * the client's terse internal error instead of the message naming the fix.
 */
async function withClient(
  client: ObservabilityClient | undefined,
  name: ObservabilityToolName,
  fn: (c: ObservabilityClient) => Promise<ToolResult<unknown>>,
): Promise<string> {
  const { urlKey, service } = ENDPOINTS[TOOL_ENDPOINT[name]];
  if (!client?.[urlKey]) return applyOutputPipeline(notConfigured(service));
  return applyOutputPipeline(await fn(client));
}

function makePromAlertsTool(client: ObservabilityClient | undefined) {
  return tool(
    "kinetica_prom_alerts",
    "Read the cluster's Prometheus alerting rules AND their live state in one call: every configured alert with its expression — this site's OWN threshold for what counts as too high, so prefer it to any generic figure — plus for-duration, severity, rule health, and every currently firing or pending instance with the value that tripped it and how long it has been active. Firing rules sort first. This is the fastest Round-1 signal available: what the site's own monitoring is already flagging. IMPORTANT: zero rules means this site has configured NO Prometheus alerting, NOT that nothing is wrong — the result tells you which, and silence from an unconfigured monitor is not evidence of health. Kinetica's own database-native alerts (gpudb.conf alert_memory_percentage, alert_disk_percentage, heartbeat) are pushed straight to Alertmanager and never appear here — read those with kinetica_cluster_status. A rule whose health is 'err' can never fire, so treat it as a monitoring gap, not as a quiet subsystem. Optional 'contains' narrows by rule name.",
    PromAlertsSchema.shape,
    async (args: PromAlertsInput) =>
      text(await withClient(client, "kinetica_prom_alerts", (c) => promAlerts(c, args))),
    { annotations: { readOnly: true } },
  );
}

function makeTierSnapshotTool(client: ObservabilityClient | undefined) {
  return tool(
    "kinetica_tier_snapshot",
    "Per-rank, per-tier storage utilization from Prometheus, with an eviction verdict. Returns one row per rank+tier: used, limit, used_pct, windowed peak and when it occurred, unevictable bytes, bytes remaining until eviction begins, cumulative evictions, and a status of ok | pressure | over high-watermark | uncapped. This is the first move of any memory- or tier-pressure investigation because it shows every rank at once. Note: 'limit' comes from ki_db_tier size_bytes, and tiers reporting -1 (typically disk0 and persist) are uncapped, so they have no meaningful percentage. Watermarks are FRACTIONS of the limit (commonly 0.9/0.8), so 'to_eviction' is the real headroom, not limit minus used. Rank 0 is the head node and reports no watermarks or eviction counters.",
    TierSnapshotSchema.shape,
    async (args: TierSnapshotInput) =>
      text(await withClient(client, "kinetica_tier_snapshot", (c) => tierSnapshot(c, args))),
    { annotations: { readOnly: true } },
  );
}

function makePromQueryTool(client: ObservabilityClient | undefined) {
  return tool(
    "kinetica_prom_query",
    "Run an arbitrary PromQL query against the cluster's Prometheus and get per-series statistics (min/max with the timestamps they occurred at, first, last, delta) rather than raw points. Use for anything kinetica_tier_snapshot does not cover. Metric families available: ki_db_tier (storage tiers), ki_db_http (connections_current), ki_db_requests, ki_db_net, ki_db_alloc, ki_db_request_duration_seconds_* (histogram), ki_db_resourcegroup, plus HOST and PROCESS telemetry no other tool can reach — ki_host_cpu{what=idle|iowait|system|user|count|context_switch_rate}, ki_host_mem{what=total|used|free|cached|buffers}, ki_host_disk, ki_host_loadavg, ki_host_numa, ki_host_swap, ki_host_vmstat, and ki_exe_mem{what=oom_score|resident_bytes|major_faults|swap_bytes} / ki_exe_cpu / ki_exe_io per process. Rank identity is the 'source' label (rank0, rank1, …), NOT a rank label. IMPORTANT: a query for a metric name that does not exist returns 0 series with HTTP 200 — identical to a metric that exists but has no data — so verify the name before concluding data is absent.",
    PromQuerySchema.shape,
    async (args: PromQueryInput) =>
      text(await withClient(client, "kinetica_prom_query", (c) => promQuery(c, args))),
    { annotations: { readOnly: true } },
  );
}

function makeLokiQueryTool(client: ObservabilityClient | undefined) {
  return tool(
    "kinetica_loki_query",
    'Query the cluster\'s Loki, which holds TWO populations selected by the \'stream\' argument. stream="events" (the DEFAULT) reads the structured events the database emits directly, in five classes — sql (one record per statement with jobid, user, resource_group, elapsed seconds and the full statement text), job (request failures with \'who\' attribution and an error code), status (rank status transitions — the stale-rank signal), config, and mode. stream="logs" reads actual rank LOG LINES, which exist only when the cluster has enable_promtail=true; these are the real rolling-log lines, and they also cover components no other live tool can reach — filter them with \'job\': gpudb_log (ranks + host manager), gpudb_sql_log, gpudb_graph_log, gpudb_reveal_log, gpudb_tomcat_log, gpudb_tomcat_access_log, gpudb_workbench_log. stream="all" reads both. The default is events on purpose: log lines outnumber events by orders of magnitude and would consume the whole limit. IMPORTANT: the two populations label the same things differently — this tool translates for you, so always say source="rank0" and severity="error" whichever stream you read. If a logs query returns nothing, the cluster most likely has promtail off (it defaults to off, and enabling it in gpudb.conf requires a stats-stack restart before anything ships) — verify with stream="events", which works regardless. Retention is short (hours to days) with no backfill, so this cannot answer questions about last week. Promtail is line-oriented, so a multi-line record such as \'Executing SQL:\' is SPLIT and its continuation lines do not reliably pair with their parent — for a complete multi-line statement or a contiguous stack trace, use a support bundle.',
    LokiQuerySchema.shape,
    async (args: LokiQueryInput) =>
      text(await withClient(client, "kinetica_loki_query", (c) => lokiQuery(c, args))),
    { annotations: { readOnly: true } },
  );
}

/**
 * Build the observability tool set.
 *
 * @param client - configured client, or undefined when no endpoint was found
 */
export function makeObservabilityTools(client: ObservabilityClient | undefined) {
  return [
    makePromAlertsTool(client),
    makeTierSnapshotTool(client),
    makePromQueryTool(client),
    makeLokiQueryTool(client),
  ];
}

/** Approval registry with every observability tool registered read-only. */
export function createObservabilityRegistry(): Registry {
  return OBSERVABILITY_TOOL_NAMES.reduce(
    (registry, name) => registry.registerReadOnlyTool(name),
    createRegistry(),
  );
}
