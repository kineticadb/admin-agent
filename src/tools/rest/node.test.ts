import { describe, it, expect, vi, beforeEach } from "vitest";
import type { KineticaSession } from "../../types/index.js";

const mockMakeRequest = vi.fn();

const mockSession: KineticaSession = {
  baseUrl: "http://localhost:9191",
  makeRequest: mockMakeRequest,
};

async function getNodeDetails() {
  const mod = await import("./node.js");
  return mod.nodeDetails;
}

/**
 * Build a triple-encoded response matching real Kinetica
 * /show/resource/statistics.
 */
function makeTripleEncodedResponse() {
  const rank0 = {
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
  };

  const rank1 = {
    tiers: {
      RAM: {
        overall: {
          used: 2147483648,
          limit: 8589934592,
        },
      },
    },
    resource_groups: {},
  };

  const ranksEncoded: Record<string, string> = {
    "0": JSON.stringify(rank0),
    "1": JSON.stringify(rank1),
  };

  const statsMap = { ranks: JSON.stringify(ranksEncoded) };

  return JSON.stringify({
    status: "OK",
    data_str: JSON.stringify({ statistics_map: statsMap }),
  });
}

describe("nodeDetails", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("returns ok:true with summary rows when no nodeId provided", async () => {
    mockMakeRequest.mockResolvedValueOnce(
      new Response(makeTripleEncodedResponse(), { status: 200 }),
    );

    const nodeDetails = await getNodeDetails();
    const result = await nodeDetails(mockSession);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { rank: string }[];
      expect(data).toHaveLength(2);
      expect(data[0].rank).toBe("0");
      expect(data[1].rank).toBe("1");
      expect(result.note).toBeUndefined();
    }
    expect(mockMakeRequest).toHaveBeenCalledWith("/show/resource/statistics", {
      options: {},
    });
  });

  it("returns detailed breakdown when nodeId matches a rank", async () => {
    mockMakeRequest.mockResolvedValueOnce(
      new Response(makeTripleEncodedResponse(), { status: 200 }),
    );

    const nodeDetails = await getNodeDetails();
    const result = await nodeDetails(mockSession, "0");

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        tiers: Record<string, string>[];
        resource_groups: Record<string, string>[];
      };
      expect(data.tiers).toHaveLength(2); // RAM, PERSIST
      expect(data.tiers[0].tier).toBe("RAM");
      expect(data.tiers[0].used).toBe("1073741824");
      expect(data.resource_groups).toHaveLength(1);
      expect(data.resource_groups[0].name).toBe("default");
      expect(data.resource_groups[0].thread_running_count).toBe("4");
      expect(result.note).toBeUndefined();
    }
  });

  it("returns summary rows with note when nodeId not found", async () => {
    mockMakeRequest.mockResolvedValueOnce(
      new Response(makeTripleEncodedResponse(), { status: 200 }),
    );

    const nodeDetails = await getNodeDetails();
    const result = await nodeDetails(mockSession, "99");

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { rank: string }[];
      expect(data).toHaveLength(2);
      expect(result.note).toBe("node_id '99' not found in statistics_map — returning all nodes");
    }
  });

  it("returns ok:false with status and raw on non-200 response", async () => {
    mockMakeRequest.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    const nodeDetails = await getNodeDetails();
    const result = await nodeDetails(mockSession);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toBe("HTTP 404");
      expect(result.raw).toBe("Not Found");
    }
  });

  it("returns ok:false with parse error message when JSON is invalid", async () => {
    mockMakeRequest.mockResolvedValueOnce(new Response("{invalid", { status: 200 }));

    const nodeDetails = await getNodeDetails();
    const result = await nodeDetails(mockSession);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(200);
      expect(result.error).toMatch(/JSON parse error/);
    }
  });

  it("returns ok:false when data_str is a malformed JSON string", async () => {
    const responseBody = JSON.stringify({
      status: "OK",
      data_str: "not-valid-json",
    });

    mockMakeRequest.mockResolvedValueOnce(new Response(responseBody, { status: 200 }));

    const nodeDetails = await getNodeDetails();
    const result = await nodeDetails(mockSession);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/data_str parse error/);
    }
  });

  it("never throws — network errors return ok:false", async () => {
    mockMakeRequest.mockRejectedValueOnce(new Error("Network unreachable"));

    const nodeDetails = await getNodeDetails();
    await expect(nodeDetails(mockSession)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Network unreachable"),
    });
  });
});
