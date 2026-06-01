import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KineticaSession } from "../../types/index.js";

/**
 * clusterStatus now makes requests to two services:
 *   - DB engine via makeRequest: operations, shards, system-properties (HM port discovery), jobs
 *   - Host manager via makeRequestToPort: alerts
 */

const mockMakeRequest = vi.fn();
const mockMakeRequestToPort = vi.fn();

const mockSession: KineticaSession = {
  baseUrl: "http://localhost:9191",
  makeRequest: mockMakeRequest,
  makeRequestToPort: mockMakeRequestToPort,
};

async function getClusterStatus() {
  const mod = await import("./cluster.js");
  return mod.clusterStatus;
}

// Helper to create a simple Response
function makeResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/** System properties response that returns hm_http_port = 9300 */
function makeHmPortResponse() {
  return makeResponse({
    data_str: JSON.stringify({
      property_map: { "conf.hm_http_port": "9300" },
    }),
  });
}

describe("clusterStatus", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("returns ok:true with merged data from all four endpoints on success", async () => {
    const operationsData = { status: "OK" };
    const shardsData = {
      shard_array_version: 5,
      shard_map: { "0": "rank_0", "1": "rank_1", "2": "rank_0", "3": "rank_1" },
    };
    const alertsData = {
      data_str: JSON.stringify({
        timestamps: ["2026-03-01T10:00:00Z", "2026-03-01T11:00:00Z"],
        types: ["INFO", "WARN"],
        params: ["param_a", "param_b"],
      }),
    };
    const jobsData = {
      data_str: JSON.stringify({
        job_id: ["job_1", "job_2"],
        status: ["RUNNING", "COMPLETE"],
        endpoint_name: ["/insert/records", "/clear/table"],
      }),
    };

    // DB engine: operations, shards, system-properties (HM port discovery), jobs
    mockMakeRequest
      .mockResolvedValueOnce(makeResponse(operationsData))
      .mockResolvedValueOnce(makeResponse(shardsData))
      .mockResolvedValueOnce(makeHmPortResponse())
      .mockResolvedValueOnce(makeResponse(jobsData));

    // Host manager: alerts
    mockMakeRequestToPort.mockResolvedValueOnce(makeResponse(alertsData));

    const clusterStatus = await getClusterStatus();
    const result = await clusterStatus(mockSession);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        operations: unknown;
        shards: unknown;
        alerts: Array<{ timestamp: string; type: string; params: string }>;
        jobs: Array<{ job_id: string; status: string; endpoint: string }>;
      };
      expect(data.operations).toEqual(operationsData);
      // Shards are now summarized, not raw
      expect(data.shards).toEqual({
        shard_array_version: 5,
        total_shards: 4,
        rank_count: 2,
        distribution: [
          { rank: "rank_0", shard_count: 2, percent: "50.0%" },
          { rank: "rank_1", shard_count: 2, percent: "50.0%" },
        ],
        balanced: true,
      });
      // Alerts: zipped from parallel arrays
      expect(data.alerts).toEqual([
        { timestamp: "2026-03-01T10:00:00Z", type: "INFO", params: "param_a" },
        { timestamp: "2026-03-01T11:00:00Z", type: "WARN", params: "param_b" },
      ]);
      // Jobs: zipped from parallel arrays
      expect(data.jobs).toEqual([
        {
          job_id: "job_1",
          status: "RUNNING",
          endpoint: "/insert/records",
        },
        {
          job_id: "job_2",
          status: "COMPLETE",
          endpoint: "/clear/table",
        },
      ]);
    }
  });

  it("routes alerts to host manager via makeRequestToPort on discovered port", async () => {
    const emptyAlerts = {
      data_str: JSON.stringify({ timestamps: [], types: [], params: [] }),
    };
    const emptyJobs = {
      data_str: JSON.stringify({ job_id: [], status: [], endpoint_name: [] }),
    };

    // DB engine: operations, shards, system-properties, jobs
    mockMakeRequest
      .mockResolvedValueOnce(makeResponse({}))
      .mockResolvedValueOnce(makeResponse({}))
      .mockResolvedValueOnce(makeHmPortResponse())
      .mockResolvedValueOnce(makeResponse(emptyJobs));

    // Host manager: alerts
    mockMakeRequestToPort.mockResolvedValueOnce(makeResponse(emptyAlerts));

    const clusterStatus = await getClusterStatus();
    await clusterStatus(mockSession);

    // DB engine calls
    expect(mockMakeRequest).toHaveBeenNthCalledWith(1, "/admin/show/cluster/operations", {
      options: {},
    });
    expect(mockMakeRequest).toHaveBeenNthCalledWith(2, "/admin/show/shards", {
      options: {},
    });
    // 3rd call is system-properties for HM port discovery
    expect(mockMakeRequest).toHaveBeenNthCalledWith(3, "/show/system/properties", {
      options: {},
    });
    expect(mockMakeRequest).toHaveBeenNthCalledWith(4, "/admin/show/jobs", {
      options: { show_async_jobs: "true", show_worker_info: "true" },
    });

    // Host manager call — alerts on discovered port 9300
    expect(mockMakeRequestToPort).toHaveBeenCalledWith(9300, "/admin/show/alerts", {
      num_alerts: 50,
      options: {},
    });
  });

  it("returns ok:false when any sub-request fails (operations fails)", async () => {
    mockMakeRequest.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

    const clusterStatus = await getClusterStatus();
    const result = await clusterStatus(mockSession);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toBe("HTTP 500");
      expect(result.raw).toBe("Internal Server Error");
    }
  });

  it("returns ok:true with empty alerts when host manager is unreachable (graceful degradation)", async () => {
    const emptyJobs = {
      data_str: JSON.stringify({ job_id: [], status: [], endpoint_name: [] }),
    };

    // DB engine: operations, shards, system-properties, jobs
    mockMakeRequest
      .mockResolvedValueOnce(makeResponse({}))
      .mockResolvedValueOnce(makeResponse({}))
      .mockResolvedValueOnce(makeHmPortResponse())
      .mockResolvedValueOnce(makeResponse(emptyJobs));

    // Host manager: alerts endpoint returns 404
    mockMakeRequestToPort.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    const clusterStatus = await getClusterStatus();
    const result = await clusterStatus(mockSession);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.alerts).toEqual([]);
      expect(result.note).toMatch(/not available/);
    }
  });

  it("returns ok:false when JSON parse fails for any sub-response", async () => {
    mockMakeRequest
      .mockResolvedValueOnce(makeResponse({}))
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }));

    const clusterStatus = await getClusterStatus();
    const result = await clusterStatus(mockSession);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/JSON parse error/);
    }
  });

  it("never throws — network errors return ok:false", async () => {
    mockMakeRequest.mockRejectedValueOnce(new Error("Timeout"));

    const clusterStatus = await getClusterStatus();
    await expect(clusterStatus(mockSession)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Timeout"),
    });
  });

  it("returns ok:false when alerts data_str is a malformed JSON string", async () => {
    // DB engine: operations, shards, system-properties
    mockMakeRequest
      .mockResolvedValueOnce(makeResponse({}))
      .mockResolvedValueOnce(makeResponse({}))
      .mockResolvedValueOnce(makeHmPortResponse());

    // Host manager: alerts with malformed data_str
    mockMakeRequestToPort.mockResolvedValueOnce(makeResponse({ data_str: "not-valid-json" }));

    // Jobs (called after alerts)
    mockMakeRequest.mockResolvedValueOnce(
      makeResponse({ data_str: JSON.stringify({ job_id: [], status: [], endpoint_name: [] }) }),
    );

    const clusterStatus = await getClusterStatus();
    const result = await clusterStatus(mockSession);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/data_str parse error/);
    }
  });

  it("zips empty alerts and jobs arrays correctly", async () => {
    const emptyAlerts = {
      data_str: JSON.stringify({ timestamps: [], types: [], params: [] }),
    };
    const emptyJobs = {
      data_str: JSON.stringify({ job_id: [], status: [], endpoint_name: [] }),
    };

    // DB engine: operations, shards, system-properties, jobs
    mockMakeRequest
      .mockResolvedValueOnce(makeResponse({}))
      .mockResolvedValueOnce(makeResponse({}))
      .mockResolvedValueOnce(makeHmPortResponse())
      .mockResolvedValueOnce(makeResponse(emptyJobs));

    // Host manager: alerts
    mockMakeRequestToPort.mockResolvedValueOnce(makeResponse(emptyAlerts));

    const clusterStatus = await getClusterStatus();
    const result = await clusterStatus(mockSession);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as unknown as { alerts: unknown[]; jobs: unknown[] };
      expect(data.alerts).toEqual([]);
      expect(data.jobs).toEqual([]);
    }
  });

  it("falls back to default HM port 9300 when system-properties fails", async () => {
    const emptyAlerts = {
      data_str: JSON.stringify({ timestamps: [], types: [], params: [] }),
    };
    const emptyJobs = {
      data_str: JSON.stringify({ job_id: [], status: [], endpoint_name: [] }),
    };

    // DB engine: operations, shards succeed; system-properties fails (e.g. 503)
    mockMakeRequest
      .mockResolvedValueOnce(makeResponse({}))
      .mockResolvedValueOnce(makeResponse({}))
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(makeResponse(emptyJobs));

    // Host manager: alerts on default port 9300
    mockMakeRequestToPort.mockResolvedValueOnce(makeResponse(emptyAlerts));

    const clusterStatus = await getClusterStatus();
    await clusterStatus(mockSession);

    // Should fall back to default port 9300
    expect(mockMakeRequestToPort).toHaveBeenCalledWith(9300, "/admin/show/alerts", {
      num_alerts: 50,
      options: {},
    });
  });
});
