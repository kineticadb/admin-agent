/**
 * TDD tests for alterSystemProperties.
 *
 * Tests define the contract BEFORE implementation (RED phase).
 * Three-phase lifecycle: before-state read -> mutation -> post-mutation verify.
 * Before-state read failure does NOT block mutation.
 * Never throws -- all error paths return ToolResult with ok:false.
 */
import { describe, it, expect, vi } from "vitest";
import {
  AlterSystemPropertiesSchema,
  alterSystemProperties,
  findDisallowedProperties,
} from "./alter-system-properties.js";
import type { KineticaSession } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Creates a session whose makeRequest resolves with a fixed JSON body.
 * Used for simple single-call tests.
 */
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

/**
 * Creates a session whose makeRequest returns different responses on each call.
 * Used to simulate the three-phase lifecycle:
 *   call 1: /show/system/properties (before-state)
 *   call 2: /alter/system/properties (mutation)
 *   call 3: /show/system/properties (post-mutation verification)
 */
function makeMultiSession(responses: Array<{ body: unknown; status?: number }>): KineticaSession {
  const mockFn = vi.fn();
  for (const r of responses) {
    const status = r.status ?? 200;
    if (status !== 200) {
      mockFn.mockResolvedValueOnce(new Response(`HTTP error ${status}`, { status }));
    } else {
      mockFn.mockResolvedValueOnce(new Response(JSON.stringify(r.body), { status: 200 }));
    }
  }
  return {
    baseUrl: "http://localhost:9191",
    makeRequest: mockFn,
  };
}

// ---------------------------------------------------------------------------
// Sample Kinetica response payloads
// ---------------------------------------------------------------------------

/** Simulates /show/system/properties returning a property_map. */
function makeShowPropertiesResponse(propertyMap: Record<string, string>) {
  return {
    status: "OK",
    data_str: JSON.stringify({ property_map: propertyMap }),
  };
}

/** Simulates /alter/system/properties returning updated_properties_map. */
function makeAlterResponse(updatedMap: Record<string, string>) {
  return {
    status: "OK",
    data_str: JSON.stringify({ updated_properties_map: updatedMap }),
  };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("AlterSystemPropertiesSchema", () => {
  it("accepts valid property_updates_map with one entry", () => {
    const result = AlterSystemPropertiesSchema.safeParse({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid property_updates_map with multiple entries", () => {
    const result = AlterSystemPropertiesSchema.safeParse({
      property_updates_map: {
        subtask_concurrency_limit: "8",
        request_timeout: "30",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty property_updates_map", () => {
    const result = AlterSystemPropertiesSchema.safeParse({
      property_updates_map: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing property_updates_map", () => {
    const result = AlterSystemPropertiesSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects non-string values in property_updates_map", () => {
    const result = AlterSystemPropertiesSchema.safeParse({
      property_updates_map: { subtask_concurrency_limit: 8 },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// alterSystemProperties function
// ---------------------------------------------------------------------------

describe("alterSystemProperties", () => {
  it("calls /show/system/properties before mutation for before-state", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });

    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ subtask_concurrency_limit: "4" }) }, // before
      { body: makeAlterResponse({ subtask_concurrency_limit: "8" }) }, // mutation
      { body: makeShowPropertiesResponse({ subtask_concurrency_limit: "8" }) }, // verify
    ]);

    await alterSystemProperties(session, input);

    const calls = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("/show/system/properties");
  });

  it("calls /alter/system/properties with property_updates_map body", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });

    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ subtask_concurrency_limit: "4" }) },
      { body: makeAlterResponse({ subtask_concurrency_limit: "8" }) },
      { body: makeShowPropertiesResponse({ subtask_concurrency_limit: "8" }) },
    ]);

    await alterSystemProperties(session, input);

    const calls = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][0]).toBe("/alter/system/properties");
    expect(calls[1][1]).toMatchObject({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });
  });

  it("calls /show/system/properties after mutation for verification", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });

    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ subtask_concurrency_limit: "4" }) },
      { body: makeAlterResponse({ subtask_concurrency_limit: "8" }) },
      { body: makeShowPropertiesResponse({ subtask_concurrency_limit: "8" }) },
    ]);

    await alterSystemProperties(session, input);

    const calls = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[2][0]).toBe("/show/system/properties");
  });

  it("returns ok:true with before_state, after_state, updated_properties_map, and verification:confirmed when values match", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });

    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ subtask_concurrency_limit: "4" }) },
      { body: makeAlterResponse({ subtask_concurrency_limit: "8" }) },
      { body: makeShowPropertiesResponse({ subtask_concurrency_limit: "8" }) },
    ]);

    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        before_state: Record<string, string>;
        after_state: Record<string, string>;
        updated_properties_map: Record<string, string>;
        verification: string;
      };
      expect(data.before_state).toEqual({ subtask_concurrency_limit: "4" });
      expect(data.after_state).toEqual({ subtask_concurrency_limit: "8" });
      expect(data.updated_properties_map).toEqual({ subtask_concurrency_limit: "8" });
      expect(data.verification).toBe("confirmed");
    }
  });

  it("returns verification:failed when after-state does not match requested values", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });

    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ subtask_concurrency_limit: "4" }) },
      { body: makeAlterResponse({ subtask_concurrency_limit: "8" }) },
      // After-state still shows old value -- change did not stick
      { body: makeShowPropertiesResponse({ subtask_concurrency_limit: "4" }) },
    ]);

    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { verification: string };
      expect(data.verification).toBe("failed");
    }
  });

  it("returns verification:unavailable when post-mutation read fails", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });

    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ subtask_concurrency_limit: "4" }) },
      { body: makeAlterResponse({ subtask_concurrency_limit: "8" }) },
      { body: null, status: 503 }, // verification read fails
    ]);

    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { verification: string };
      expect(data.verification).toBe("unavailable");
    }
  });

  it("before-state read failure does NOT block mutation -- proceeds with empty before_state", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });

    const session = makeMultiSession([
      { body: null, status: 503 }, // before-state read fails
      { body: makeAlterResponse({ subtask_concurrency_limit: "8" }) }, // mutation still proceeds
      { body: makeShowPropertiesResponse({ subtask_concurrency_limit: "8" }) }, // verify
    ]);

    const result = await alterSystemProperties(session, input);

    // Mutation should still succeed
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        before_state: Record<string, string>;
        verification: string;
      };
      expect(data.before_state).toEqual({});
      expect(data.verification).toBe("confirmed");
    }
  });

  it("returns ok:false on non-200 HTTP response from mutation call", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });

    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ subtask_concurrency_limit: "4" }) },
      { body: null, status: 503 }, // mutation fails
    ]);

    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
    }
  });

  it("returns ok:false with parse error on invalid JSON from mutation call", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });

    const mockFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(makeShowPropertiesResponse({ subtask_concurrency_limit: "4" })),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }));

    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: mockFn,
    };

    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/JSON parse error/);
    }
  });

  it("returns ok:false with data_str parse error when mutation response data_str is malformed", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });

    const mockFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(makeShowPropertiesResponse({ subtask_concurrency_limit: "4" })),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "OK", data_str: "not-valid-json" }), { status: 200 }),
      );

    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: mockFn,
    };

    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/data_str parse error/);
    }
  });

  it("never throws -- network error on mutation call returns ok:false", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });

    const mockFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(makeShowPropertiesResponse({ subtask_concurrency_limit: "4" })),
          { status: 200 },
        ),
      )
      .mockRejectedValueOnce(new Error("Connection refused"));

    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: mockFn,
    };

    await expect(alterSystemProperties(session, input)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Connection refused"),
    });
  });

  it("only extracts requested keys from property_map for before_state", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { subtask_concurrency_limit: "8" },
    });

    const session = makeMultiSession([
      // Before-state response has many more properties than requested
      {
        body: makeShowPropertiesResponse({
          subtask_concurrency_limit: "4",
          unrelated_property: "some-value",
          another_property: "other-value",
        }),
      },
      { body: makeAlterResponse({ subtask_concurrency_limit: "8" }) },
      { body: makeShowPropertiesResponse({ subtask_concurrency_limit: "8" }) },
    ]);

    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        before_state: Record<string, string>;
        after_state: Record<string, string>;
      };
      // Should only contain the key we requested to change
      expect(data.before_state).toEqual({ subtask_concurrency_limit: "4" });
      expect(Object.keys(data.before_state)).toHaveLength(1);
    }
  });

  it("returns ok:false when property is not in allow-list -- no network call", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { nonexistent_property: "value" },
    });

    const session = makeSession(null);
    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/Property rejected/);
      expect(result.error).toContain("nonexistent_property");
    }
    // No network call should have been made
    expect(session.makeRequest).not.toHaveBeenCalled();
  });

  it("returns ok:false when blocked property ai_api_key is requested -- no network call", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { ai_api_key: "sk-secret" },
    });

    const session = makeSession(null);
    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/Property rejected/);
    }
    expect(session.makeRequest).not.toHaveBeenCalled();
  });

  it("rejects entire request when any property is invalid -- no partial application", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: {
        subtask_concurrency_limit: "8",
        nonexistent_property: "value",
      },
    });

    const session = makeSession(null);
    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(false);
    expect(session.makeRequest).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// findDisallowedProperties
// ---------------------------------------------------------------------------

describe("findDisallowedProperties", () => {
  it("returns empty array for a valid property", () => {
    expect(findDisallowedProperties(["subtask_concurrency_limit"])).toEqual([]);
  });

  it("returns empty array for multiple valid properties", () => {
    expect(
      findDisallowedProperties(["subtask_concurrency_limit", "request_timeout", "enable_audit"]),
    ).toEqual([]);
  });

  it("returns invalid property name for unknown property", () => {
    expect(findDisallowedProperties(["nonexistent_property"])).toEqual(["nonexistent_property"]);
  });

  it("returns blocked property even though API supports it", () => {
    expect(findDisallowedProperties(["ai_api_key"])).toEqual(["ai_api_key"]);
  });

  it("returns blocked external_files_directory", () => {
    expect(findDisallowedProperties(["external_files_directory"])).toEqual([
      "external_files_directory",
    ]);
  });

  it("returns only the disallowed keys from a mixed set", () => {
    const result = findDisallowedProperties([
      "subtask_concurrency_limit",
      "fake_property",
      "ai_api_key",
    ]);
    expect(result).toEqual(["fake_property", "ai_api_key"]);
  });

  it("returns all keys when none are valid", () => {
    const result = findDisallowedProperties(["foo", "bar"]);
    expect(result).toEqual(["foo", "bar"]);
  });
});
