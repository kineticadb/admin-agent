import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KineticaSession } from "../../types/index.js";

const mockMakeRequest = vi.fn();

const mockSession: KineticaSession = {
  baseUrl: "http://localhost:9191",
  makeRequest: mockMakeRequest,
};

async function getGetMetrics() {
  const mod = await import("./metrics.js");
  return mod.getMetrics;
}

/**
 * Build a triple-encoded response body matching real Kinetica
 * /show/resource/statistics. Encoding levels:
 *   rank data → JSON string, ranks map → JSON string, data_str → JSON string
 */
function makeTripleEncodedResponse(rankOverrides?: Record<string, Record<string, unknown>>) {
  const defaultRanks: Record<string, Record<string, unknown>> = {
    "0": {
      tiers: {
        RAM: {
          overall: {
            used: 1073741824,
            limit: 8589934592,
          },
        },
        PERSIST: { overall: { used: 5368709120 } },
      },
      resource_groups: {
        default: { thread_running_count: 4, data: {} },
      },
    },
  };

  const ranks = rankOverrides ?? defaultRanks;

  // Triple-encode: each rank value → JSON string, then ranks object → JSON string
  const ranksEncoded: Record<string, string> = {};
  for (const [id, data] of Object.entries(ranks)) {
    ranksEncoded[id] = JSON.stringify(data);
  }

  const statsMap = { ranks: JSON.stringify(ranksEncoded) };

  return JSON.stringify({
    status: "OK",
    data_str: JSON.stringify({ statistics_map: statsMap }),
  });
}

describe("getMetrics", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("returns ok:true with flattened rank summary rows (no nodeId)", async () => {
    mockMakeRequest.mockResolvedValueOnce(
      new Response(makeTripleEncodedResponse(), { status: 200 }),
    );

    const getMetrics = await getGetMetrics();
    const result = await getMetrics(mockSession);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([
        {
          rank: "0",
          ram_used: "1073741824",
          ram_limit: "8589934592",
          ram_percent: "12.5%",
          persist_used: "5368709120",
          disk_used: "",
          vram_used: "",
        },
      ]);
      expect(result.note).toBeUndefined();
    }
    expect(mockMakeRequest).toHaveBeenCalledWith("/show/resource/statistics", {
      options: {},
    });
  });

  it("returns ok:true with note when nodeId is provided", async () => {
    mockMakeRequest.mockResolvedValueOnce(
      new Response(makeTripleEncodedResponse(), { status: 200 }),
    );

    const getMetrics = await getGetMetrics();
    const result = await getMetrics(mockSession, "0");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.note).toBe("Filtered for node: 0");
    }
  });

  it("returns ok:false with status and raw on non-200 response", async () => {
    mockMakeRequest.mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }));

    const getMetrics = await getGetMetrics();
    const result = await getMetrics(mockSession);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toBe("HTTP 503");
      expect(result.raw).toBe("Service Unavailable");
    }
  });

  it("returns ok:false with parse error message when JSON is invalid", async () => {
    mockMakeRequest.mockResolvedValueOnce(new Response("bad-json", { status: 200 }));

    const getMetrics = await getGetMetrics();
    const result = await getMetrics(mockSession);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(200);
      expect(result.error).toMatch(/JSON parse error/);
      expect(result.raw).toBe("bad-json");
    }
  });

  it("returns ok:false when data_str is a malformed JSON string", async () => {
    const responseBody = JSON.stringify({
      status: "OK",
      data_str: "not-valid-json",
    });

    mockMakeRequest.mockResolvedValueOnce(new Response(responseBody, { status: 200 }));

    const getMetrics = await getGetMetrics();
    const result = await getMetrics(mockSession);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/data_str parse error/);
    }
  });

  it("never throws — network errors return ok:false", async () => {
    mockMakeRequest.mockRejectedValueOnce(new Error("Connection refused"));

    const getMetrics = await getGetMetrics();
    await expect(getMetrics(mockSession)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Connection refused"),
    });
  });
});
