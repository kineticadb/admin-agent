import { describe, it, expect, vi } from "vitest";
import { ShowSecuritySchema, showSecurity } from "./security.js";
import type { KineticaSession } from "../../types/index.js";

// security.ts does not exist yet — these tests define the expected contract
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
    types: { admin: "admin", user1: "normal_user" },
    roles: { user1: ["role_a"] },
    permissions: { user1: ["table.orders.select"] },
    resource_groups: { user1: "default" },
  }),
};

// ---- Schema validation ----

describe("ShowSecuritySchema", () => {
  it("accepts empty object with default names applied", () => {
    const result = ShowSecuritySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.names).toEqual([""]);
    }
  });

  it("accepts names array", () => {
    const result = ShowSecuritySchema.safeParse({ names: ["user1", "admin"] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.names).toEqual(["user1", "admin"]);
    }
  });

  it("rejects names as string instead of array", () => {
    const result = ShowSecuritySchema.safeParse({ names: "user1" });
    expect(result.success).toBe(false);
  });
});

// ---- showSecurity function ----

describe("showSecurity", () => {
  it("returns ok:true with data_str containing types/roles/permissions/resource_groups", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ShowSecuritySchema.parse({});
    const result = await showSecurity(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        types: Record<string, string>;
        roles: Record<string, string[]>;
      };
      expect(data.types).toMatchObject({ admin: "admin", user1: "normal_user" });
      expect(data.roles).toMatchObject({ user1: ["role_a"] });
    }
  });

  it("calls /show/security with names and options:{}", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ShowSecuritySchema.parse({ names: ["admin"] });
    await showSecurity(session, input);

    expect(session.makeRequest).toHaveBeenCalledWith("/show/security", {
      names: ["admin"],
      options: {},
    });
  });

  it('uses default names:[""] when not specified', async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ShowSecuritySchema.parse({});
    await showSecurity(session, input);

    expect(session.makeRequest).toHaveBeenCalledWith("/show/security", {
      names: [""],
      options: {},
    });
  });

  it("returns ok:false with status on non-200 response", async () => {
    const session = makeSession(null, 403);
    const input = ShowSecuritySchema.parse({});
    const result = await showSecurity(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toBe("HTTP 403");
    }
  });

  it("returns ok:false with parse error on invalid JSON", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })),
    };

    const input = ShowSecuritySchema.parse({});
    const result = await showSecurity(session, input);

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

    const input = ShowSecuritySchema.parse({});
    const result = await showSecurity(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/data_str parse error/);
    }
  });

  it("never throws — network errors return ok:false", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockRejectedValue(new Error("Network timeout")),
    };

    const input = ShowSecuritySchema.parse({});
    await expect(showSecurity(session, input)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Network timeout"),
    });
  });
});
