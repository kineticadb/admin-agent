/**
 * In-memory KineticaSession backed by canned Responses. Lets evals run the
 * full agent loop without a live Kinetica instance. Unknown endpoints return
 * an empty success rather than throwing — keeps the agent from crashing when
 * a scenario doesn't explicitly mock every endpoint it probes.
 */

import type { KineticaSession } from "../types/index.js";

export function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Kinetica's double-encoded `data_str` envelope (DB engine, port 9191). */
export function dataStrResponse(inner: unknown): Response {
  return jsonResponse({ status: "OK", data_str: JSON.stringify(inner) });
}

/** Per-endpoint response factories keyed by endpoint path. */
export type MockResponseMap = Readonly<Record<string, () => Response>>;

/** A healthy two-rank Kinetica 7.2 system — enough for the agent to finish Round 1. */
const DEFAULT_DB_RESPONSES: MockResponseMap = {
  "/show/system/status": () =>
    dataStrResponse({
      status_map: {
        system_status: "running",
        "host1.ram_used": "4500000000",
        "host1.ram_total": "16000000000",
        "rank0.host": "host1",
        "rank0.state": "running",
        "rank1.host": "host1",
        "rank1.state": "running",
        version: "7.2.3.11.20260317111832",
      },
    }),
  "/show/system/properties": () =>
    dataStrResponse({
      property_map: {
        "conf.hm_http_port": "9300",
        "conf.worker_http_server_ports": "9191",
        version: "7.2.3.11.20260317111832",
      },
    }),
  "/show/resource/statistics": () =>
    dataStrResponse({
      statistics_map: {
        ranks: JSON.stringify([
          JSON.stringify({
            rank: 0,
            host: "host1",
            tier: { stats: { cpu_percent: 12, ram_used: 1.2e9, ram_total: 8e9 } },
          }),
          JSON.stringify({
            rank: 1,
            host: "host1",
            tier: { stats: { cpu_percent: 18, ram_used: 3.3e9, ram_total: 8e9 } },
          }),
        ]),
      },
    }),
  "/show/system/timing": () => dataStrResponse({ endpoint_timings: [], total_requests: "0" }),
  "/show/resourcegroups": () =>
    dataStrResponse({
      groups: [
        { name: "kinetica_system_resource_group", priority: "100" },
        { name: "kinetica_default_resource_group", priority: "50" },
      ],
    }),
  "/admin/verifydb": () =>
    dataStrResponse({
      verified_ok: true,
      orphaned_tables_total_size: "-1",
      errors: [],
    }),
  "/show/security": () => dataStrResponse({ users: [], roles: [], permissions: [] }),
  "/show/table": () =>
    dataStrResponse({
      table_names: [],
      sizes: [],
      properties: [],
      type_schemas: [],
    }),
  "/show/resource/objects": () =>
    dataStrResponse({
      rank_objects: [JSON.stringify({ objects: [] }), JSON.stringify({ objects: [] })],
    }),
  "/admin/show/shards": () =>
    dataStrResponse({
      shard_array_version: 1,
      shard_map: { "0": "0", "1": "1", "2": "0", "3": "1" },
    }),
  "/admin/show/logs": () =>
    new Response(JSON.stringify({ status: "ERROR", message: "Unknown URI" }), { status: 404 }),
  "/execute/sql": () =>
    dataStrResponse({
      count_affected: "0",
      column_headers: [],
      column_datatypes: [],
      json_encoded_response: JSON.stringify({}),
    }),
};

/** Host manager responses (port 9300) — plain JSON, no envelope. */
const DEFAULT_HM_RESPONSES: MockResponseMap = {
  "/": () =>
    jsonResponse({
      version: "7.2.3.11",
      license_status: "valid",
      license_expiration: "2030-01-01",
      system_status: "running",
      system_mode: "normal",
      ml_status: "running",
      query_planner_status: "running",
      reveal_status: "running",
      graph0_status: "running",
      text0_status: "running",
      ranks: [
        { rank: 0, pid: "1001", status: "running" },
        { rank: 1, pid: "1002", status: "running" },
      ],
    }),
  "/admin/show/configuration": () =>
    dataStrResponse({ config_string: "# Minimal mock gpudb.conf\n" }),
};

export type MockSessionOptions = {
  readonly dbResponses?: MockResponseMap;
  readonly hmResponses?: MockResponseMap;
};

/**
 * Creates a mock KineticaSession bound to static canned responses.
 * Safe to call repeatedly — no shared mutable state.
 */
export function createMockSession(options: MockSessionOptions = {}): KineticaSession {
  const db = { ...DEFAULT_DB_RESPONSES, ...(options.dbResponses ?? {}) };
  const hm = { ...DEFAULT_HM_RESPONSES, ...(options.hmResponses ?? {}) };

  return {
    baseUrl: "http://mock-host:9191",
    makeRequest: (endpoint: string) => {
      const factory = db[endpoint] ?? (() => dataStrResponse({}));
      return Promise.resolve(factory());
    },
    makeRequestToPort: (port: number, endpoint: string) => {
      if (port === 9300) {
        const factory = hm[endpoint] ?? (() => jsonResponse({}));
        return Promise.resolve(factory());
      }
      const factory = db[endpoint] ?? (() => dataStrResponse({}));
      return Promise.resolve(factory());
    },
  };
}

/**
 * A cluster with rank 2 down — the state in which restarting is the obvious remediation.
 *
 * Exists so an eval can exercise the `service-management` trigger. Against the default
 * healthy mock the agent has nothing to restart, so the remediation touches no service,
 * the trigger never fires, and the highest-risk document in the corpus (the one that
 * exists because the agent once invented `gadmin restart rank 2`) goes untested.
 *
 * Lives here rather than in the `.eval.ts` file because vitest excludes `*.eval.ts`: a
 * wrong endpoint key or response shape would otherwise only surface on a paid run.
 */
export function createStaleRankSession(): KineticaSession {
  return createMockSession({
    dbResponses: {
      "/show/system/status": () =>
        dataStrResponse({
          status_map: {
            system_status: "degraded",
            "rank0.host": "host1",
            "rank0.state": "running",
            "rank1.host": "host1",
            "rank1.state": "running",
            "rank2.host": "host2",
            "rank2.state": "not_responding",
            version: "7.2.3.11.20260317111832",
          },
        }),
    },
    hmResponses: {
      "/": () =>
        jsonResponse({
          version: "7.2.3.11",
          license_status: "valid",
          license_expiration: "2030-01-01",
          system_status: "degraded",
          system_mode: "normal",
          ranks: [
            { rank: 0, pid: "1001", status: "running" },
            { rank: 1, pid: "1002", status: "running" },
            { rank: 2, pid: "", status: "stopped" },
          ],
        }),
    },
  });
}
/**
 * A cluster whose `tps_per_tom` was raised in `gpudb.conf` but never applied — the file
 * says 8, the running process is still on 4, and only a restart closes the gap.
 *
 * Exists to probe the INCIDENTAL-restart case, which neither other scenario reaches.
 * `createStaleRankSession` covers the obvious one (a rank is down; restarting IS the
 * investigation), and `memory-pressure` was measured across three live runs to instruct a
 * service action exactly once — its remediation lands on a restart only when the agent
 * happens to chase a data-loss hypothesis, so it probes this by luck rather than by
 * construction. Neither reproduces the failure of 2026-09-16, where the agent wrote
 * `systemctl stop gpudb` inside an investigation that was not about services and never read
 * `service-management`.
 *
 * The trap is measured and documented in `knowledge/references/gpudb-conf.md`:
 * `/alter/system/properties` edits the file in place and the running process never re-reads
 * it, while `/show/system/properties` reports the FILE — so a read-back shows the new value
 * whether or not it ever took effect. `tps_per_tom` is the measured example (4→8 changed
 * zero threads on either rank). The API therefore CANNOT show "written but not applied":
 * the uptime is supplied by the scenario's issue text, as a real operator would volunteer
 * it, and the diagnosis has to come from the corpus.
 */
export function createUnappliedConfigSession(): KineticaSession {
  return createMockSession({
    dbResponses: {
      "/show/system/properties": () =>
        dataStrResponse({
          property_map: {
            // hm_http_port must survive: discoverHmPort() reads it for the 9300 tools.
            "conf.hm_http_port": "9300",
            "conf.worker_http_server_ports": "9191",
            // The FILE value, written two hours ago. The live process is still on 4.
            "conf.tps_per_tom": "8",
            "conf.tcs_per_tom": "16",
            version: "7.2.3.11.20260317111832",
          },
        }),
    },
    hmResponses: {
      // The authoritative file read agrees with /show — both report the file, and neither
      // can report what the running process is actually using.
      "/admin/show/configuration": () =>
        dataStrResponse({
          config_string: ["# gpudb.conf (excerpt)", "tps_per_tom = 8", "tcs_per_tom = 16", ""].join(
            "\n",
          ),
        }),
    },
  });
}
