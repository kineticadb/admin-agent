import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KineticaSession } from "../../types/index.js";

// health.ts does not exist yet — these tests define the expected contract
// They MUST fail on first run (RED phase)

const mockMakeRequest = vi.fn();

const mockSession: KineticaSession = {
  baseUrl: "http://localhost:9191",
  makeRequest: mockMakeRequest,
};

// Dynamic import deferred to each test so we can set up mocks first
async function getHealthCheck() {
  const mod = await import("./health.js");
  return mod.healthCheck;
}

describe("healthCheck", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("returns ok:true with status_map on 200 response", async () => {
    const statusMap = { head: "running", worker_1: "running" };
    const responseBody = JSON.stringify({
      status: "OK",
      data_str: JSON.stringify({ status_map: statusMap, info: {} }),
    });

    mockMakeRequest.mockResolvedValueOnce(new Response(responseBody, { status: 200 }));

    const healthCheck = await getHealthCheck();
    const result = await healthCheck(mockSession);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([
        { component: "head", status: "running" },
        { component: "worker_1", status: "running" },
      ]);
    }
    expect(mockMakeRequest).toHaveBeenCalledWith("/show/system/status", {});
  });

  it("returns ok:false with status and raw on non-200 response", async () => {
    mockMakeRequest.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

    const healthCheck = await getHealthCheck();
    const result = await healthCheck(mockSession);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("HTTP 401");
      expect(result.raw).toBe("Unauthorized");
    }
  });

  it("returns ok:false with parse error message when JSON is invalid", async () => {
    mockMakeRequest.mockResolvedValueOnce(new Response("not-json", { status: 200 }));

    const healthCheck = await getHealthCheck();
    const result = await healthCheck(mockSession);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(200);
      expect(result.error).toMatch(/JSON parse error/);
      expect(result.raw).toBe("not-json");
    }
  });

  it("returns ok:false when data_str is a malformed JSON string", async () => {
    const responseBody = JSON.stringify({
      status: "OK",
      data_str: "not-valid-json",
    });

    mockMakeRequest.mockResolvedValueOnce(new Response(responseBody, { status: 200 }));

    const healthCheck = await getHealthCheck();
    const result = await healthCheck(mockSession);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/data_str parse error/);
    }
  });

  it("never throws — rejects propagated from makeRequest return ok:false", async () => {
    mockMakeRequest.mockRejectedValueOnce(new Error("Network failure"));

    const healthCheck = await getHealthCheck();
    // Should not throw — must return a ToolResult
    await expect(healthCheck(mockSession)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Network failure"),
    });
  });
});
