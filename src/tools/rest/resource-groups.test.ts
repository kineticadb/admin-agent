import { describe, it, expect, vi } from "vitest";
import { ResourceGroupsSchema, getResourceGroups } from "./resource-groups.js";
import type { KineticaSession } from "../../types/index.js";

// resource-groups.ts does not exist yet — these tests define the expected contract
// They MUST fail on first run (RED phase)

function makeSession(body: unknown, statusCode = 200): KineticaSession {
  if (statusCode !== 200) {
    return {
      baseUrl: "http://localhost:9191",
      makeRequest: vi
        .fn()
        .mockResolvedValue(new Response(`HTTP error ${statusCode}`, { status: statusCode })),
    };
  }

  return {
    baseUrl: "http://localhost:9191",
    makeRequest: vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  };
}

const SAMPLE_RESPONSE = {
  status: "OK",
  data_str: JSON.stringify({
    groups: [{ name: "default", max_cpu_concurrency: 8, max_scheduling_priority: 100 }],
    rank_usage: { rank_0: { tier_1: { used: 1024, total: 8192 } } },
  }),
};

// ---- Schema validation ----

describe("ResourceGroupsSchema", () => {
  it("accepts empty object with defaults applied", () => {
    const result = ResourceGroupsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.names).toEqual([""]);
    }
  });

  it("accepts names array", () => {
    const result = ResourceGroupsSchema.safeParse({ names: ["group_a", "group_b"] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.names).toEqual(["group_a", "group_b"]);
    }
  });

  it("accepts show_tier_usage boolean", () => {
    const result = ResourceGroupsSchema.safeParse({ show_tier_usage: true });
    expect(result.success).toBe(true);
  });

  it("rejects show_tier_usage non-boolean", () => {
    const result = ResourceGroupsSchema.safeParse({ show_tier_usage: "yes" });
    expect(result.success).toBe(false);
  });
});

// ---- getResourceGroups function ----

describe("getResourceGroups", () => {
  it("returns ok:true with data_str on 200 response", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ResourceGroupsSchema.parse({});
    const result = await getResourceGroups(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { groups: Array<{ name: string }> };
      expect(data.groups).toHaveLength(1);
      expect(data.groups[0]).toMatchObject({ name: "default" });
    }
  });

  it("calls /show/resourcegroups with correct body", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ResourceGroupsSchema.parse({});
    await getResourceGroups(session, input);

    expect(session.makeRequest).toHaveBeenCalledWith("/show/resourcegroups", {
      names: [""],
      options: {
        show_tier_usage: "false",
        show_default_values: "true",
        show_default_group: "true",
      },
    });
  });

  it("includes show_tier_usage:true when requested", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ResourceGroupsSchema.parse({ show_tier_usage: true });
    await getResourceGroups(session, input);

    expect(session.makeRequest).toHaveBeenCalledWith("/show/resourcegroups", {
      names: [""],
      options: {
        show_tier_usage: "true",
        show_default_values: "true",
        show_default_group: "true",
      },
    });
  });

  it("returns ok:false with status on non-200 response", async () => {
    const session = makeSession(null, 401);
    const input = ResourceGroupsSchema.parse({});
    const result = await getResourceGroups(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("HTTP 401");
    }
  });

  it("returns ok:false with parse error on invalid JSON", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })),
    };

    const input = ResourceGroupsSchema.parse({});
    const result = await getResourceGroups(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(200);
      expect(result.error).toMatch(/JSON parse error/);
    }
  });

  it("returns ok:false when data_str is a malformed JSON string", async () => {
    const session = makeSession({
      status: "OK",
      data_str: "not-valid-json",
    });

    const input = ResourceGroupsSchema.parse({});
    const result = await getResourceGroups(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/data_str parse error/);
    }
  });

  it("never throws — network errors return ok:false", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockRejectedValue(new Error("Connection refused")),
    };

    const input = ResourceGroupsSchema.parse({});
    await expect(getResourceGroups(session, input)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Connection refused"),
    });
  });
});
