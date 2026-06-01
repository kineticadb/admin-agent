import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KineticaSession } from "../../types/index.js";

// host-manager.ts does not exist yet — these tests define the expected contract
// They MUST fail on first run (RED phase)

const mockMakeRequest = vi.fn();
const mockMakeRequestToPort = vi.fn();

const mockSessionWithPort: KineticaSession = {
  baseUrl: "http://localhost:9191",
  makeRequest: mockMakeRequest,
  makeRequestToPort: mockMakeRequestToPort,
};

const mockSessionWithoutPort: KineticaSession = {
  baseUrl: "http://localhost:9191",
  makeRequest: mockMakeRequest,
};

// Dynamic import deferred to each test so we can set up mocks first
async function getHostManagerStatus() {
  const mod = await import("./host-manager.js");
  return mod.hostManagerStatus;
}

async function getHostManagerAlerts() {
  const mod = await import("./host-manager.js");
  return mod.hostManagerAlerts;
}

const hmRootResponse = {
  version: "7.2.3.11.20260317111832",
  hostname: "host1",
  system_mode: "run",
  system_status: "running",
  system_idle_time: "622",
  cluster_leader: "10.0.0.1",
  cluster_operation: "none",
  cluster_operation_status: "",
  system_rebalancing: 0,
  license_type: "key-enterprise",
  license_status: "ok",
  license_expiration: "2030-11-14",
  host_mode: "run",
  host_status: "running",
  host_pid: 505340,
  ml_status: "disabled",
  rank0_mode: "run",
  rank0_status: "running",
  rank0_pid: 514094,
  rank1_mode: "run",
  rank1_status: "running",
  rank1_pid: 514548,
};

describe("hostManagerStatus", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("returns ok:true with flat JSON data on 200 response from makeRequestToPort", async () => {
    // First call: getSystemProperties (port discovery) — returns hm port
    mockMakeRequest.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "OK",
          data_str: JSON.stringify({ property_map: { "conf.hm_http_port": "9300" } }),
        }),
        { status: 200 },
      ),
    );
    // Second call: makeRequestToPort on port 9300 for root /
    mockMakeRequestToPort.mockResolvedValueOnce(
      new Response(JSON.stringify(hmRootResponse), { status: 200 }),
    );

    const hostManagerStatus = await getHostManagerStatus();
    const result = await hostManagerStatus(mockSessionWithPort);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Result should be array of {key, value} rows from flatObjectToRows
      expect(Array.isArray(result.data)).toBe(true);
      const rows = result.data as ReadonlyArray<Record<string, unknown>>;
      const systemModeRow = rows.find((r) => r.key === "system_mode");
      expect(systemModeRow).toBeDefined();
      expect(systemModeRow?.value).toBe("run");
    }
    expect(mockMakeRequestToPort).toHaveBeenCalledWith(9300, "/", undefined);
  });

  it("returns ok:false when makeRequestToPort is not available on the session", async () => {
    const hostManagerStatus = await getHostManagerStatus();
    const result = await hostManagerStatus(mockSessionWithoutPort);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(0);
      expect(result.error).toMatch(/makeRequestToPort not available/);
      expect(result.raw).toBe("");
    }
    // makeRequest should NOT be called at all
    expect(mockMakeRequest).not.toHaveBeenCalled();
  });

  it("returns ok:false with status and raw on non-200 HTTP response from host manager", async () => {
    // Port discovery succeeds
    mockMakeRequest.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "OK",
          data_str: JSON.stringify({ property_map: { "conf.hm_http_port": "9300" } }),
        }),
        { status: 200 },
      ),
    );
    // Host manager returns 503
    mockMakeRequestToPort.mockResolvedValueOnce(
      new Response("Service Unavailable", { status: 503 }),
    );

    const hostManagerStatus = await getHostManagerStatus();
    const result = await hostManagerStatus(mockSessionWithPort);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toBe("HTTP 503");
      expect(result.raw).toBe("Service Unavailable");
    }
  });

  it("returns ok:false with JSON parse error on malformed response body", async () => {
    // Port discovery succeeds
    mockMakeRequest.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "OK",
          data_str: JSON.stringify({ property_map: { "conf.hm_http_port": "9300" } }),
        }),
        { status: 200 },
      ),
    );
    // Host manager returns malformed JSON
    mockMakeRequestToPort.mockResolvedValueOnce(new Response("not-valid-json", { status: 200 }));

    const hostManagerStatus = await getHostManagerStatus();
    const result = await hostManagerStatus(mockSessionWithPort);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(200);
      expect(result.error).toMatch(/JSON parse error/);
      expect(result.raw).toBe("not-valid-json");
    }
  });

  it("never throws — network errors from makeRequestToPort return ok:false", async () => {
    // Port discovery succeeds
    mockMakeRequest.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "OK",
          data_str: JSON.stringify({ property_map: { "conf.hm_http_port": "9300" } }),
        }),
        { status: 200 },
      ),
    );
    // makeRequestToPort throws a network error
    mockMakeRequestToPort.mockRejectedValueOnce(new Error("Connection refused"));

    const hostManagerStatus = await getHostManagerStatus();
    await expect(hostManagerStatus(mockSessionWithPort)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Connection refused"),
    });
  });

  it("discovers HM port from system properties before making the root request", async () => {
    // Port discovery returns custom port 9301
    mockMakeRequest.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "OK",
          data_str: JSON.stringify({ property_map: { "conf.hm_http_port": "9301" } }),
        }),
        { status: 200 },
      ),
    );
    mockMakeRequestToPort.mockResolvedValueOnce(
      new Response(JSON.stringify(hmRootResponse), { status: 200 }),
    );

    const hostManagerStatus = await getHostManagerStatus();
    await hostManagerStatus(mockSessionWithPort);

    // Should have discovered port 9301 and used it
    expect(mockMakeRequestToPort).toHaveBeenCalledWith(9301, "/", undefined);
  });

  it("falls back to DEFAULT_HM_PORT (9300) when system properties lookup fails", async () => {
    // Port discovery fails (getSystemProperties returns error)
    mockMakeRequest.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));
    mockMakeRequestToPort.mockResolvedValueOnce(
      new Response(JSON.stringify(hmRootResponse), { status: 200 }),
    );

    const hostManagerStatus = await getHostManagerStatus();
    const result = await hostManagerStatus(mockSessionWithPort);

    expect(result.ok).toBe(true);
    // Should fall back to port 9300
    expect(mockMakeRequestToPort).toHaveBeenCalledWith(9300, "/", undefined);
  });
});

// ---------------------------------------------------------------------------
// hostManagerAlerts
// ---------------------------------------------------------------------------

/** Build a valid /admin/show/alerts response with data_str double-encoding. */
function makeAlertsResponse(
  timestamps: string[] = [],
  types: string[] = [],
  params: string[] = [],
): string {
  return JSON.stringify({
    data_str: JSON.stringify({ timestamps, types, params }),
  });
}

/** Stub system properties for HM port discovery (returns default 9300). */
function stubPortDiscoveryFailure(): void {
  mockMakeRequest.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));
}

describe("hostManagerAlerts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("returns parsed alerts from /admin/show/alerts on HM port", async () => {
    stubPortDiscoveryFailure();
    mockMakeRequestToPort.mockResolvedValueOnce(
      new Response(
        makeAlertsResponse(
          ["2026-03-24 10:00:00", "2026-03-24 09:00:00"],
          ["System", "Rank"],
          ["CPU high", "Rank 1 slow"],
        ),
        { status: 200 },
      ),
    );

    const hostManagerAlerts = await getHostManagerAlerts();
    const result = await hostManagerAlerts(mockSessionWithPort);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual({
        timestamp: "2026-03-24 10:00:00",
        type: "System",
        params: "CPU high",
      });
      expect(result.data[1]).toEqual({
        timestamp: "2026-03-24 09:00:00",
        type: "Rank",
        params: "Rank 1 slow",
      });
    }
    expect(mockMakeRequestToPort).toHaveBeenCalledWith(9300, "/admin/show/alerts", {
      num_alerts: 50,
      options: {},
    });
  });

  it("returns empty array when no alerts exist", async () => {
    stubPortDiscoveryFailure();
    mockMakeRequestToPort.mockResolvedValueOnce(
      new Response(makeAlertsResponse(), { status: 200 }),
    );

    const hostManagerAlerts = await getHostManagerAlerts();
    const result = await hostManagerAlerts(mockSessionWithPort);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(0);
    }
  });

  it("returns ok:false when makeRequestToPort is not available", async () => {
    const hostManagerAlerts = await getHostManagerAlerts();
    const result = await hostManagerAlerts(mockSessionWithoutPort);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/makeRequestToPort not available/);
    }
  });

  it("returns ok:false on non-200 HTTP response", async () => {
    stubPortDiscoveryFailure();
    mockMakeRequestToPort.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    const hostManagerAlerts = await getHostManagerAlerts();
    const result = await hostManagerAlerts(mockSessionWithPort);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toBe("HTTP 404");
    }
  });

  it("returns ok:false on network error", async () => {
    stubPortDiscoveryFailure();
    mockMakeRequestToPort.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const hostManagerAlerts = await getHostManagerAlerts();
    const result = await hostManagerAlerts(mockSessionWithPort);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ECONNREFUSED");
    }
  });

  it("returns ok:false on malformed outer JSON", async () => {
    stubPortDiscoveryFailure();
    mockMakeRequestToPort.mockResolvedValueOnce(new Response("not-json", { status: 200 }));

    const hostManagerAlerts = await getHostManagerAlerts();
    const result = await hostManagerAlerts(mockSessionWithPort);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/JSON parse error/);
    }
  });

  it("returns ok:false on malformed data_str", async () => {
    stubPortDiscoveryFailure();
    mockMakeRequestToPort.mockResolvedValueOnce(
      new Response(JSON.stringify({ data_str: "not-json" }), { status: 200 }),
    );

    const hostManagerAlerts = await getHostManagerAlerts();
    const result = await hostManagerAlerts(mockSessionWithPort);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/data_str parse error/);
    }
  });

  it("handles missing data_str gracefully (returns empty alerts)", async () => {
    stubPortDiscoveryFailure();
    mockMakeRequestToPort.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const hostManagerAlerts = await getHostManagerAlerts();
    const result = await hostManagerAlerts(mockSessionWithPort);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(0);
    }
  });

  it("discovers HM port from system properties", async () => {
    mockMakeRequest.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "OK",
          data_str: JSON.stringify({ property_map: { "conf.hm_http_port": "9301" } }),
        }),
        { status: 200 },
      ),
    );
    mockMakeRequestToPort.mockResolvedValueOnce(
      new Response(makeAlertsResponse(), { status: 200 }),
    );

    const hostManagerAlerts = await getHostManagerAlerts();
    await hostManagerAlerts(mockSessionWithPort);

    expect(mockMakeRequestToPort).toHaveBeenCalledWith(9301, "/admin/show/alerts", {
      num_alerts: 50,
      options: {},
    });
  });
});
