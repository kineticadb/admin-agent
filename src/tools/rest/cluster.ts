/**
 * clusterStatus — queries cluster-wide topology, alerts, and active jobs.
 *
 * Makes requests to two Kinetica services:
 *   DB engine (session.baseUrl):
 *     1. /admin/show/cluster/operations — current operation status
 *     2. /admin/show/shards            — shard-to-rank mapping
 *     4. /admin/show/jobs              — active async jobs
 *   Host manager (discovered via conf.hm_http_port, default 9300):
 *     3. /admin/show/alerts            — recent system alerts (last 50)
 *
 * Alerts gracefully degrade to an empty array if the host manager is unreachable.
 * Alerts and jobs use parallel arrays in Kinetica's response format.
 * These are zipped into objects before returning.
 *
 * Never throws — all error paths return ToolResult with ok:false.
 * Never mutates session or response objects.
 */
import type { KineticaSession, ToolResult } from "../../types/index.js";
import { parseDataStr } from "./parse-data-str.js";
import { summarizeShards, type ShardSummary } from "./summarize-shards.js";
import { discoverHmPort } from "./discover-hm-port.js";

type AlertEntry = {
  readonly timestamp: string;
  readonly type: string;
  readonly params: string;
};

type JobEntry = {
  readonly job_id: string;
  readonly status: string;
  readonly endpoint: string;
};

type ClusterData = {
  readonly operations: unknown;
  readonly shards: ShardSummary;
  readonly alerts: ReadonlyArray<AlertEntry>;
  readonly jobs: ReadonlyArray<JobEntry>;
};

/** Fetch a single endpoint and parse JSON, returning ToolResult */
async function fetchJson(
  session: KineticaSession,
  endpoint: string,
  body: unknown,
): Promise<ToolResult<unknown>> {
  let response: Response;
  let rawText: string;

  try {
    response = await session.makeRequest(endpoint, body);
    rawText = await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: message, raw: "" };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}`,
      raw: rawText,
    };
  }

  try {
    const parsed = JSON.parse(rawText) as unknown;
    return { ok: true, data: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 200,
      error: `JSON parse error: ${message}`,
      raw: rawText,
    };
  }
}

/** Fetch a single endpoint on a specific port and parse JSON. */
async function fetchJsonOnPort(
  session: KineticaSession,
  port: number,
  endpoint: string,
  body: unknown,
): Promise<ToolResult<unknown>> {
  if (!session.makeRequestToPort) {
    return {
      ok: false,
      status: 0,
      error: "makeRequestToPort not available on this session",
      raw: "",
    };
  }

  let response: Response;
  let rawText: string;

  try {
    response = await session.makeRequestToPort(port, endpoint, body);
    rawText = await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: message, raw: "" };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}`,
      raw: rawText,
    };
  }

  try {
    const parsed = JSON.parse(rawText) as unknown;
    return { ok: true, data: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 200,
      error: `JSON parse error: ${message}`,
      raw: rawText,
    };
  }
}

export async function clusterStatus(session: KineticaSession): Promise<ToolResult<ClusterData>> {
  // 1. Cluster operations
  const opsResult = await fetchJson(session, "/admin/show/cluster/operations", { options: {} });
  if (!opsResult.ok) return opsResult;

  // 2. Shards
  const shardsResult = await fetchJson(session, "/admin/show/shards", {
    options: {},
  });
  if (!shardsResult.ok) return shardsResult;

  // 3. Alerts (last 50) — served by the host manager, not the DB engine
  const hmPort = await discoverHmPort(session);
  const alertsResult = await fetchJsonOnPort(session, hmPort, "/admin/show/alerts", {
    num_alerts: 50,
    options: {},
  });
  const alertsAvailable = alertsResult.ok;

  // 4. Jobs
  const jobsResult = await fetchJson(session, "/admin/show/jobs", {
    options: { show_async_jobs: "true", show_worker_info: "true" },
  });
  if (!jobsResult.ok) return jobsResult;

  // Double-decode alerts data_str (JSON-encoded string)
  // Gracefully degrade if /admin/show/alerts returned 404
  let alerts: ReadonlyArray<AlertEntry> = [];
  if (alertsAvailable) {
    type AlertsData = {
      timestamps?: string[];
      types?: string[];
      params?: string[];
    };
    const alertsOuter = alertsResult.data as { data_str?: string };
    const alertsInner = parseDataStr<AlertsData>(
      alertsOuter.data_str,
      JSON.stringify(alertsResult.data),
    );
    if (!alertsInner.ok) return alertsInner;

    const timestamps = alertsInner.data?.timestamps ?? [];
    const alertTypes = alertsInner.data?.types ?? [];
    const alertParams = alertsInner.data?.params ?? [];
    alerts = timestamps.map((ts, i) => ({
      timestamp: ts,
      type: alertTypes[i] ?? "",
      params: alertParams[i] ?? "",
    }));
  }

  // Double-decode jobs data_str (JSON-encoded string)
  type JobsData = {
    job_id?: string[];
    status?: string[];
    endpoint_name?: string[];
  };
  const jobsOuter = jobsResult.data as { data_str?: string };
  const jobsInner = parseDataStr<JobsData>(jobsOuter.data_str, JSON.stringify(jobsResult.data));
  if (!jobsInner.ok) return jobsInner;

  const jobIds = jobsInner.data?.job_id ?? [];
  const jobStatuses = jobsInner.data?.status ?? [];
  const jobEndpoints = jobsInner.data?.endpoint_name ?? [];
  const jobs: ReadonlyArray<JobEntry> = jobIds.map((id, i) => ({
    job_id: id,
    status: jobStatuses[i] ?? "",
    endpoint: jobEndpoints[i] ?? "",
  }));

  return {
    ok: true,
    data: {
      operations: opsResult.data,
      shards: summarizeShards(shardsResult.data),
      alerts,
      jobs,
    },
    ...(alertsAvailable
      ? {}
      : { note: "/admin/show/alerts not available on this version — alerts array is empty" }),
  };
}
