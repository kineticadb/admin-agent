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
  findRestartSuspectProperties,
  lookupProperty,
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
      property_updates_map: { request_timeout: "8" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid property_updates_map with multiple entries", () => {
    const result = AlterSystemPropertiesSchema.safeParse({
      property_updates_map: {
        request_timeout: "8",
        chunk_size: "4000000",
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
      property_updates_map: { request_timeout: 8 },
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
      property_updates_map: { request_timeout: "8" },
    });

    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ request_timeout: "4" }) }, // before
      { body: makeAlterResponse({ request_timeout: "8" }) }, // mutation
      { body: makeShowPropertiesResponse({ request_timeout: "8" }) }, // verify
    ]);

    await alterSystemProperties(session, input);

    const calls = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe("/show/system/properties");
  });

  it("calls /alter/system/properties with property_updates_map body", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { request_timeout: "8" },
    });

    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ request_timeout: "4" }) },
      { body: makeAlterResponse({ request_timeout: "8" }) },
      { body: makeShowPropertiesResponse({ request_timeout: "8" }) },
    ]);

    await alterSystemProperties(session, input);

    const calls = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][0]).toBe("/alter/system/properties");
    expect(calls[1][1]).toMatchObject({
      property_updates_map: { request_timeout: "8" },
    });
  });

  it("calls /show/system/properties after mutation for verification", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { request_timeout: "8" },
    });

    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ request_timeout: "4" }) },
      { body: makeAlterResponse({ request_timeout: "8" }) },
      { body: makeShowPropertiesResponse({ request_timeout: "8" }) },
    ]);

    await alterSystemProperties(session, input);

    const calls = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[2][0]).toBe("/show/system/properties");
  });

  it("returns ok:true with before_state, after_state, updated_properties_map, and verification:confirmed when values match", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { request_timeout: "8" },
    });

    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ request_timeout: "4" }) },
      { body: makeAlterResponse({ request_timeout: "8" }) },
      { body: makeShowPropertiesResponse({ request_timeout: "8" }) },
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
      expect(data.before_state).toEqual({ request_timeout: "4" });
      expect(data.after_state).toEqual({ request_timeout: "8" });
      expect(data.updated_properties_map).toEqual({ request_timeout: "8" });
      expect(data.verification).toBe("confirmed");
    }
  });

  it("returns verification:failed when after-state does not match requested values", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { request_timeout: "8" },
    });

    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ request_timeout: "4" }) },
      { body: makeAlterResponse({ request_timeout: "8" }) },
      // After-state still shows old value -- change did not stick
      { body: makeShowPropertiesResponse({ request_timeout: "4" }) },
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
      property_updates_map: { request_timeout: "8" },
    });

    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ request_timeout: "4" }) },
      { body: makeAlterResponse({ request_timeout: "8" }) },
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
      property_updates_map: { request_timeout: "8" },
    });

    const session = makeMultiSession([
      { body: null, status: 503 }, // before-state read fails
      { body: makeAlterResponse({ request_timeout: "8" }) }, // mutation still proceeds
      { body: makeShowPropertiesResponse({ request_timeout: "8" }) }, // verify
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
      property_updates_map: { request_timeout: "8" },
    });

    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ request_timeout: "4" }) },
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
      property_updates_map: { request_timeout: "8" },
    });

    const mockFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeShowPropertiesResponse({ request_timeout: "4" })), {
          status: 200,
        }),
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
      property_updates_map: { request_timeout: "8" },
    });

    const mockFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeShowPropertiesResponse({ request_timeout: "4" })), {
          status: 200,
        }),
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
      property_updates_map: { request_timeout: "8" },
    });

    const mockFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeShowPropertiesResponse({ request_timeout: "4" })), {
          status: 200,
        }),
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
      property_updates_map: { request_timeout: "8" },
    });

    const session = makeMultiSession([
      // Before-state response has many more properties than requested
      {
        body: makeShowPropertiesResponse({
          request_timeout: "4",
          unrelated_property: "some-value",
          another_property: "other-value",
        }),
      },
      { body: makeAlterResponse({ request_timeout: "8" }) },
      { body: makeShowPropertiesResponse({ request_timeout: "8" }) },
    ]);

    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        before_state: Record<string, string>;
        after_state: Record<string, string>;
      };
      // Should only contain the key we requested to change
      expect(data.before_state).toEqual({ request_timeout: "4" });
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
        request_timeout: "8",
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
    expect(findDisallowedProperties(["request_timeout"])).toEqual([]);
  });

  it("returns empty array for multiple valid properties", () => {
    expect(
      findDisallowedProperties(["request_timeout", "chunk_size", "max_concurrent_kernels"]),
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
    const result = findDisallowedProperties(["request_timeout", "fake_property", "ai_api_key"]);
    expect(result).toEqual(["fake_property", "ai_api_key"]);
  });

  it("returns all keys when none are valid", () => {
    const result = findDisallowedProperties(["foo", "bar"]);
    expect(result).toEqual(["foo", "bar"]);
  });
});

// ---------------------------------------------------------------------------
// Key-spelling tolerance
//
// /show prefixes with conf. and dot-sections what /alter flattens. A bare-name
// read-back found nothing, so verification said "failed" for every mutation.
// Fixtures were all unprefixed, so the suite confirmed the bug instead of
// catching it -- hence the real spellings below.
// ---------------------------------------------------------------------------

describe("lookupProperty", () => {
  it("finds an exactly-named property", () => {
    expect(lookupProperty({ request_timeout: "8" }, "request_timeout")).toBe("8");
  });

  it("finds a conf.-prefixed property from the bare name", () => {
    expect(lookupProperty({ "conf.request_timeout": "8" }, "request_timeout")).toBe("8");
  });

  it("prefers the exact match over the prefixed one", () => {
    expect(
      lookupProperty({ request_timeout: "8", "conf.request_timeout": "99" }, "request_timeout"),
    ).toBe("8");
  });

  it("returns undefined when neither spelling is present", () => {
    expect(lookupProperty({ "conf.chunk_size": "1" }, "request_timeout")).toBeUndefined();
  });

  it("does not loose-match a name that merely contains the key", () => {
    expect(lookupProperty({ "conf.foo_request_timeout": "8" }, "request_timeout")).toBeUndefined();
  });

  it("does not match a longer suffix", () => {
    expect(lookupProperty({ "conf.request_timeout_ms": "8" }, "request_timeout")).toBeUndefined();
  });

  it("returns undefined for an empty map", () => {
    expect(lookupProperty({}, "request_timeout")).toBeUndefined();
  });

  // /show also uses hierarchical DOT notation for sectioned keys, where /alter
  // takes the whole name flattened with underscores. 12 of
  // the 43 allow-listed properties are only reachable this way.
  it.each([
    ["ai_api_url", "conf.ai.api.url"],
    ["ai_enable_rag", "conf.ai.enable_rag"],
    ["kafka_batch_size", "conf.kafka.batch_size"],
    ["telm_persist_query_metrics", "conf.telm.persist_query_metrics"],
    // section name itself contains an underscore -- so this is not a
    // mechanical "replace the first underscore" rule
    ["postgres_proxy_keep_alive", "conf.postgres_proxy.keep_alive"],
    ["ai_api_connection_timeout", "conf.ai.api.connection_timeout"],
  ])("finds %s under its dotted spelling %s", (bare, dotted) => {
    expect(lookupProperty({ [dotted]: "v" }, bare)).toBe("v");
  });

  it("prefers conf.<exact> over a dotted match", () => {
    expect(
      lookupProperty({ "conf.ai_api_url": "exact", "conf.ai.api.url": "dotted" }, "ai_api_url"),
    ).toBe("exact");
  });

  it("returns undefined when two keys normalise to the same name (ambiguous)", () => {
    expect(lookupProperty({ "conf.a.b_c": "one", "conf.a_b.c": "two" }, "a_b_c")).toBeUndefined();
  });

  it("does not confuse a genuinely different sectioned key", () => {
    expect(lookupProperty({ "conf.kafka.poll_timeout": "0" }, "kafka_wait_time")).toBeUndefined();
  });
});

describe("alterSystemProperties -- prefixed responses from a real cluster", () => {
  const input = AlterSystemPropertiesSchema.parse({
    property_updates_map: { request_timeout: "8" },
  });

  it("confirms the mutation when the cluster returns conf.-prefixed names", async () => {
    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ "conf.request_timeout": "4" }) },
      { body: makeAlterResponse({ request_timeout: "8" }) },
      { body: makeShowPropertiesResponse({ "conf.request_timeout": "8" }) },
    ]);

    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        before_state: Record<string, string>;
        after_state: Record<string, string>;
        verification: string;
      };
      // Keyed by the bare name the caller asked for, not the wire spelling.
      expect(data.before_state).toEqual({ request_timeout: "4" });
      expect(data.after_state).toEqual({ request_timeout: "8" });
      expect(data.verification).toBe("confirmed");
    }
  });

  it("still reports failed when a prefixed value genuinely did not change", async () => {
    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ "conf.request_timeout": "4" }) },
      { body: makeAlterResponse({ request_timeout: "8" }) },
      { body: makeShowPropertiesResponse({ "conf.request_timeout": "4" }) },
    ]);

    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { verification: string }).verification).toBe("failed");
    }
  });

  it("reports not_reported for a property present under neither spelling", async () => {
    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ "conf.chunk_size": "1" }) },
      { body: makeAlterResponse({ request_timeout: "8" }) },
      { body: makeShowPropertiesResponse({ "conf.chunk_size": "1" }) },
    ]);

    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { before_state: Record<string, string>; verification: string };
      expect(data.before_state).toEqual({});
      // Absent from the read-back is "unreadable", not "unchanged".
      expect(data.verification).toBe("not_reported");
    }
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// not_reported -- unreadable is not unchanged
//
// 7 of the 43 properties are absent from /show (e.g. execution_mode, which
// /alter accepts and echoes). Reporting that as "failed" calls a successful
// mutation a failure.
// ---------------------------------------------------------------------------

describe("verification distinguishes unreadable from unchanged", () => {
  it("reports not_reported when the property is absent from the read-back", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { execution_mode: "host" },
    });
    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ "conf.chunk_size": "1" }) },
      { body: makeAlterResponse({ execution_mode: "host" }) },
      { body: makeShowPropertiesResponse({ "conf.chunk_size": "1" }) },
    ]);

    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const d = result.data as { verification: string; updated_properties_map: unknown };
      expect(d.verification).toBe("not_reported");
      // The endpoint's own echo is the only evidence the change landed.
      expect(d.updated_properties_map).toEqual({ execution_mode: "host" });
    }
  });

  it("still reports failed when the property IS readable and differs", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { request_timeout: "8" },
    });
    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ "conf.request_timeout": "4" }) },
      { body: makeAlterResponse({ request_timeout: "8" }) },
      { body: makeShowPropertiesResponse({ "conf.request_timeout": "4" }) },
    ]);

    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { verification: string }).verification).toBe("failed");
    }
  });

  it("prefers failed over not_reported in a mixed request", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { request_timeout: "8", execution_mode: "host" },
    });
    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ "conf.request_timeout": "4" }) },
      { body: makeAlterResponse({ request_timeout: "8", execution_mode: "host" }) },
      { body: makeShowPropertiesResponse({ "conf.request_timeout": "4" }) },
    ]);

    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { verification: string }).verification).toBe("failed");
    }
  });

  it("reports confirmed only when every requested key was read back and matches", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { request_timeout: "8", chunk_size: "100" },
    });
    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ "conf.request_timeout": "4", "conf.chunk_size": "8" }) },
      { body: makeAlterResponse({ request_timeout: "8", chunk_size: "100" }) },
      {
        body: makeShowPropertiesResponse({
          "conf.request_timeout": "8",
          "conf.chunk_size": "100",
        }),
      },
    ]);

    const result = await alterSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { verification: string }).verification).toBe("confirmed");
    }
  });
});

// ---------------------------------------------------------------------------
// Restart-suspect properties
//
// Measured: all four store and read back, but the running process
// ignores them (zero thread change, no audit output). So the note must warn
// about EFFECT, never acceptance.
// ---------------------------------------------------------------------------

describe("findRestartSuspectProperties", () => {
  it("flags the four accepted-but-effect-unverified keys", () => {
    expect(
      findRestartSuspectProperties([
        "tps_per_tom",
        "tcs_per_tom",
        "subtask_concurrency_limit",
        "enable_audit",
      ]),
    ).toEqual(["tps_per_tom", "tcs_per_tom", "subtask_concurrency_limit", "enable_audit"]);
  });

  it("does not flag enable_procs -- the endpoint rejects it outright", () => {
    expect(findRestartSuspectProperties(["enable_procs"])).toEqual([]);
  });

  it("does not flag an ordinary property", () => {
    expect(findRestartSuspectProperties(["request_timeout", "chunk_size"])).toEqual([]);
  });
});

describe("restart_note -- warns about effect, not acceptance", () => {
  async function noteFor(verifyValue: string): Promise<string | undefined> {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { tps_per_tom: "5" },
    });
    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ "conf.tps_per_tom": "4" }) },
      { body: makeAlterResponse({ tps_per_tom: "5" }) },
      { body: makeShowPropertiesResponse({ "conf.tps_per_tom": verifyValue }) },
    ]);
    const r = await alterSystemProperties(session, input);
    return r.ok ? (r.data as { restart_note?: string }).restart_note : undefined;
  }

  it("says the value was stored but the effect is unverified", async () => {
    const note = await noteFor("5");

    expect(note).toContain("tps_per_tom");
    expect(note).toMatch(/stored|accepted/i);
    expect(note).toMatch(/effect/i);
    expect(note).toMatch(/restart/i);
    // Must NOT promise the change is live.
    expect(note).not.toMatch(/no restart is needed/i);
  });

  it("points at gpudb.conf when the value did not even store", async () => {
    const note = await noteFor("4");

    expect(note).toContain("tps_per_tom");
    expect(note).toMatch(/did not/i);
    expect(note).toMatch(/gpudb\.conf/);
  });

  it("carries no note for a property nobody flagged", async () => {
    const input = AlterSystemPropertiesSchema.parse({
      property_updates_map: { request_timeout: "8" },
    });
    const session = makeMultiSession([
      { body: makeShowPropertiesResponse({ "conf.request_timeout": "4" }) },
      { body: makeAlterResponse({ request_timeout: "8" }) },
      { body: makeShowPropertiesResponse({ "conf.request_timeout": "8" }) },
    ]);
    const r = await alterSystemProperties(session, input);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.data as { restart_note?: string }).restart_note).toBeUndefined();
    }
  });
});
