import { describe, it, expect, vi } from "vitest";
import { AdminRebalanceSchema, adminRebalance } from "./admin-rebalance.js";
import type { KineticaSession } from "../../types/index.js";

// admin-rebalance.ts does not exist yet — these tests define the expected contract.
// They MUST fail on first run (RED phase).

/**
 * Builds a mock session that returns the provided responses in sequence.
 * Each entry in `responses` becomes the next resolved value for makeRequest.
 */
function makeMultiSession(responses: Array<{ body: unknown; status?: number }>): KineticaSession {
  const makeRequest = vi.fn();
  for (const r of responses) {
    const status = r.status ?? 200;
    if (status !== 200) {
      makeRequest.mockResolvedValueOnce(new Response(`HTTP error ${status}`, { status }));
    } else {
      makeRequest.mockResolvedValueOnce(new Response(JSON.stringify(r.body), { status: 200 }));
    }
  }
  return { baseUrl: "http://localhost:9191", makeRequest };
}

function makeErrorSession(error: Error): KineticaSession {
  return {
    baseUrl: "http://localhost:9191",
    makeRequest: vi.fn().mockRejectedValue(error),
  };
}

// --- Stable mock responses ---

const SYSTEM_STATUS_RESPONSE = {
  status: "OK",
  data_str: JSON.stringify({
    shard_map: { num_shards: 128, num_ranks: 2 },
    db_status: "OK",
  }),
};

const REBALANCE_RESPONSE = {
  status: "OK",
  data_str: JSON.stringify({
    info: {
      rebalance_initiated: "true",
      num_objects_rebalanced: "0",
    },
  }),
};

// ---- Schema validation ----

describe("AdminRebalanceSchema", () => {
  it("accepts empty object — all params are optional", () => {
    const result = AdminRebalanceSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts aggressiveness=3 with rebalance_sharded_data=true", () => {
    const result = AdminRebalanceSchema.safeParse({
      aggressiveness: 3,
      rebalance_sharded_data: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects aggressiveness > 5", () => {
    const result = AdminRebalanceSchema.safeParse({ aggressiveness: 6 });
    expect(result.success).toBe(false);
  });

  it("rejects aggressiveness < 1", () => {
    const result = AdminRebalanceSchema.safeParse({ aggressiveness: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects aggressiveness = 0", () => {
    const result = AdminRebalanceSchema.safeParse({ aggressiveness: 0 });
    expect(result.success).toBe(false);
  });

  it("accepts aggressiveness = 1 (minimum)", () => {
    const result = AdminRebalanceSchema.safeParse({ aggressiveness: 1 });
    expect(result.success).toBe(true);
  });

  it("accepts aggressiveness = 5 (maximum)", () => {
    const result = AdminRebalanceSchema.safeParse({ aggressiveness: 5 });
    expect(result.success).toBe(true);
  });

  it("does NOT have repair_incorrectly_sharded_data field", () => {
    // The schema should strip unknown fields OR this field was never added.
    // Confirm it is not an accepted property by checking the schema shape.
    const schemaKeys = Object.keys(AdminRebalanceSchema.shape);
    expect(schemaKeys).not.toContain("repair_incorrectly_sharded_data");
  });
});

// ---- adminRebalance function ----

describe("adminRebalance", () => {
  it("calls /admin/rebalance with { options } body", async () => {
    const session = makeMultiSession([
      { body: SYSTEM_STATUS_RESPONSE },
      { body: REBALANCE_RESPONSE },
      { body: SYSTEM_STATUS_RESPONSE },
    ]);

    const input = AdminRebalanceSchema.parse({});
    await adminRebalance(session, input);

    const calls = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls;
    const rebalanceCall = calls.find((c) => c[0] === "/admin/rebalance");
    expect(rebalanceCall).toBeDefined();
    expect(rebalanceCall?.[1]).toHaveProperty("options");
  });

  it("only includes explicitly provided params in options (omits undefined)", async () => {
    const session = makeMultiSession([
      { body: SYSTEM_STATUS_RESPONSE },
      { body: REBALANCE_RESPONSE },
      { body: SYSTEM_STATUS_RESPONSE },
    ]);

    // Only aggressiveness is provided
    const input = AdminRebalanceSchema.parse({ aggressiveness: 3 });
    await adminRebalance(session, input);

    const calls = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls;
    const rebalanceCall = calls.find((c) => c[0] === "/admin/rebalance");
    const options = (rebalanceCall?.[1] as { options: Record<string, string> }).options;

    expect(options).toHaveProperty("aggressiveness");
    // Unset fields must NOT appear
    expect(options).not.toHaveProperty("rebalance_sharded_data");
    expect(options).not.toHaveProperty("rebalance_unsharded_data");
    expect(options).not.toHaveProperty("table_includes");
    expect(options).not.toHaveProperty("compact_after_rebalance");
  });

  it("converts boolean params to string ('true'/'false') in options", async () => {
    const session = makeMultiSession([
      { body: SYSTEM_STATUS_RESPONSE },
      { body: REBALANCE_RESPONSE },
      { body: SYSTEM_STATUS_RESPONSE },
    ]);

    const input = AdminRebalanceSchema.parse({
      rebalance_sharded_data: true,
      rebalance_unsharded_data: false,
    });
    await adminRebalance(session, input);

    const calls = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls;
    const rebalanceCall = calls.find((c) => c[0] === "/admin/rebalance");
    const options = (rebalanceCall?.[1] as { options: Record<string, string> }).options;

    expect(options.rebalance_sharded_data).toBe("true");
    expect(options.rebalance_unsharded_data).toBe("false");
  });

  it("converts aggressiveness number to string in options", async () => {
    const session = makeMultiSession([
      { body: SYSTEM_STATUS_RESPONSE },
      { body: REBALANCE_RESPONSE },
      { body: SYSTEM_STATUS_RESPONSE },
    ]);

    const input = AdminRebalanceSchema.parse({ aggressiveness: 4 });
    await adminRebalance(session, input);

    const calls = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls;
    const rebalanceCall = calls.find((c) => c[0] === "/admin/rebalance");
    const options = (rebalanceCall?.[1] as { options: Record<string, string> }).options;

    expect(options.aggressiveness).toBe("4");
  });

  it("captures before-state by calling /show/system/status for shard info", async () => {
    const session = makeMultiSession([
      { body: SYSTEM_STATUS_RESPONSE },
      { body: REBALANCE_RESPONSE },
      { body: SYSTEM_STATUS_RESPONSE },
    ]);

    const input = AdminRebalanceSchema.parse({});
    await adminRebalance(session, input);

    const calls = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls;
    const statusCalls = calls.filter((c) => c[0] === "/show/system/status");
    // Should call /show/system/status at least once for before-state
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("before-state read failure does NOT block the rebalance — proceeds with empty before_state", async () => {
    // First call to /show/system/status fails; rebalance and after-state succeed
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error("status unreachable"))
      .mockResolvedValueOnce(new Response(JSON.stringify(REBALANCE_RESPONSE), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(SYSTEM_STATUS_RESPONSE), { status: 200 }));

    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest,
    };

    const input = AdminRebalanceSchema.parse({});
    const result = await adminRebalance(session, input);

    // Rebalance should still succeed
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.before_state).toEqual({});
    }
  });

  it("returns ok:true with { info, before_state, after_state, verification } on success", async () => {
    const session = makeMultiSession([
      { body: SYSTEM_STATUS_RESPONSE },
      { body: REBALANCE_RESPONSE },
      { body: SYSTEM_STATUS_RESPONSE },
    ]);

    const input = AdminRebalanceSchema.parse({});
    const result = await adminRebalance(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("info");
      expect(result.data).toHaveProperty("before_state");
      expect(result.data).toHaveProperty("after_state");
      expect(result.data).toHaveProperty("verification");
      expect(["confirmed", "unavailable"]).toContain(result.data.verification);
    }
  });

  it("returns ok:false on non-200 HTTP response from /admin/rebalance", async () => {
    const session = makeMultiSession([
      { body: SYSTEM_STATUS_RESPONSE },
      { body: null, status: 503 },
    ]);

    const input = AdminRebalanceSchema.parse({});
    const result = await adminRebalance(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
    }
  });

  it("never throws on network error", async () => {
    const session = makeErrorSession(new Error("Network failure"));
    const input = AdminRebalanceSchema.parse({});

    await expect(adminRebalance(session, input)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Network failure"),
    });
  });

  it("returns ok:false on malformed JSON response from /admin/rebalance", async () => {
    const makeRequest = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(SYSTEM_STATUS_RESPONSE), { status: 200 }))
      .mockResolvedValueOnce(new Response("not-valid-json", { status: 200 }));

    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest,
    };

    const input = AdminRebalanceSchema.parse({});
    const result = await adminRebalance(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/JSON parse error/);
    }
  });
});
