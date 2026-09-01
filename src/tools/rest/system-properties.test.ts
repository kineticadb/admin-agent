import { describe, it, expect, vi } from "vitest";
import { GetSystemPropertiesSchema, getSystemProperties } from "./system-properties.js";
import type { KineticaSession } from "../../types/index.js";

// ---- GetSystemPropertiesSchema validation ----

describe("GetSystemPropertiesSchema", () => {
  describe("valid inputs", () => {
    it("accepts empty object (all fields optional)", () => {
      const result = GetSystemPropertiesSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("accepts category filter", () => {
      const result = GetSystemPropertiesSchema.safeParse({ category: "memory" });
      expect(result.success).toBe(true);
    });

    it("accepts key_pattern filter", () => {
      const result = GetSystemPropertiesSchema.safeParse({ key_pattern: "gpu" });
      expect(result.success).toBe(true);
    });

    it("accepts both category and key_pattern together", () => {
      const result = GetSystemPropertiesSchema.safeParse({
        category: "system",
        key_pattern: "cache",
      });
      expect(result.success).toBe(true);
    });
  });
});

// ---- getSystemProperties function ----

/**
 * Real key names, taken from a live 7.2.3.20 cluster. The previous fixture
 * invented a namespace (memory.shared, gpu.count, network.timeout) that does not
 * exist, so the suite proved `startsWith` worked on made-up data while teaching a
 * usage that returns zero rows: /show/system/properties prefixes almost every
 * name with `conf.` and dot-sections it, so `category: "tier"` finds nothing and
 * `category: "conf.tier"` is required.
 */
const FULL_PROPERTY_MAP = {
  "conf.tier.ram.rank0.limit": "793900000",
  "conf.tier.ram.rank1.limit": "5557299999",
  "conf.tier.disk0.default.limit": "-1",
  "conf.sql.plan_cache_size": "4000",
  "conf.sql.parallel_execution": "TRUE",
  "conf.kafka.batch_size": "20000",
  "conf.tps_per_tom": "4",
  "version.gpudb_core_version": "7.2.3.20",
  "system.font_families": "DejaVu Sans",
};

function makeSession(
  propertyMap: Record<string, string> | null,
  statusCode = 200,
): KineticaSession {
  const responseBody =
    propertyMap !== null
      ? { status: "OK", data_str: JSON.stringify({ property_map: propertyMap }) }
      : null;

  if (statusCode !== 200) {
    return {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockResolvedValue({
        ok: false,
        status: statusCode,
        text: vi.fn().mockResolvedValue(`HTTP error ${statusCode}`),
        json: vi.fn().mockRejectedValue(new Error("not called")),
      }),
    };
  }

  return {
    baseUrl: "http://localhost:9191",
    makeRequest: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify(responseBody)),
      json: vi.fn().mockResolvedValue(responseBody),
    }),
  };
}

describe("getSystemProperties", () => {
  it("returns ok:true with row array when no filters provided", async () => {
    const session = makeSession(FULL_PROPERTY_MAP);

    const input = GetSystemPropertiesSchema.parse({});
    const result = await getSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Array<Record<string, string>>;
      expect(data).toHaveLength(Object.keys(FULL_PROPERTY_MAP).length);
      expect(data[0]).toEqual({ property: "conf.tier.ram.rank0.limit", value: "793900000" });
      expect(data).toContainEqual({ property: "conf.tps_per_tom", value: "4" });
      expect(result.rowCount).toBe(Object.keys(FULL_PROPERTY_MAP).length);
    }
  });

  it("filters property_map by category prefix", async () => {
    const session = makeSession(FULL_PROPERTY_MAP);

    const input = GetSystemPropertiesSchema.parse({ category: "conf.tier" });
    const result = await getSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Array<Record<string, string>>;
      const properties = data.map((r) => r.property);
      expect(properties).toEqual(
        expect.arrayContaining([
          "conf.tier.ram.rank0.limit",
          "conf.tier.ram.rank1.limit",
          "conf.tier.disk0.default.limit",
        ]),
      );
      expect(properties).not.toContain("conf.tps_per_tom");
      expect(properties).not.toContain("version.gpudb_core_version");
    }
  });

  it("filters on a partial prefix within the conf. namespace", async () => {
    const session = makeSession(FULL_PROPERTY_MAP);

    const input = GetSystemPropertiesSchema.parse({ category: "conf.tier.ram" });
    const result = await getSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Array<Record<string, string>>;
      expect(data).toHaveLength(2);
    }
  });

  // The trap the tool description warns about: category is a raw prefix match,
  // and real names carry the conf. prefix, so the intuitive bare category is
  // silently empty rather than an error.
  it.each(["tier", "sql", "kafka"])(
    "returns zero rows for the bare category %s (conf. prefix required)",
    async (category) => {
      const session = makeSession(FULL_PROPERTY_MAP);
      const result = await getSystemProperties(
        session,
        GetSystemPropertiesSchema.parse({ category }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data as unknown[]).toHaveLength(0);
    },
  );

  it("filters property_map by key_pattern (case-insensitive substring)", async () => {
    const session = makeSession(FULL_PROPERTY_MAP);

    const input = GetSystemPropertiesSchema.parse({ key_pattern: "SQL" });
    const result = await getSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Array<Record<string, string>>;
      const properties = data.map((r) => r.property);
      // key_pattern is a case-insensitive SUBSTRING, so it reaches through the
      // conf. prefix where category cannot.
      expect(properties).toEqual(
        expect.arrayContaining(["conf.sql.plan_cache_size", "conf.sql.parallel_execution"]),
      );
      expect(properties).not.toContain("conf.tps_per_tom");
    }
  });

  it("key_pattern finds a property by its bare name despite the conf. prefix", async () => {
    const session = makeSession(FULL_PROPERTY_MAP);

    const result = await getSystemProperties(
      session,
      GetSystemPropertiesSchema.parse({ key_pattern: "tps_per_tom" }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data as Array<Record<string, string>>).toContainEqual({
        property: "conf.tps_per_tom",
        value: "4",
      });
    }
  });

  it("returns correct rowCount for filtered results", async () => {
    const session = makeSession(FULL_PROPERTY_MAP);

    const input = GetSystemPropertiesSchema.parse({ category: "conf.tier" });
    const result = await getSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rowCount).toBe(3);
    }
  });

  it("calls makeRequest with /show/system/properties endpoint", async () => {
    const session = makeSession(FULL_PROPERTY_MAP);

    const input = GetSystemPropertiesSchema.parse({});
    await getSystemProperties(session, input);

    expect(session.makeRequest).toHaveBeenCalledWith("/show/system/properties", expect.any(Object));
  });

  it("returns ok:false with status on non-200 response", async () => {
    const session = makeSession(null, 503);

    const input = GetSystemPropertiesSchema.parse({});
    const result = await getSystemProperties(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
    }
  });

  it("returns ok:false on JSON parse error", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue("not-valid-json"),
        json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
      }),
    };

    const input = GetSystemPropertiesSchema.parse({});
    const result = await getSystemProperties(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(200);
      expect(result.error).toContain("JSON parse error");
    }
  });

  it("returns ok:false when data_str is a malformed JSON string", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: vi
          .fn()
          .mockResolvedValue(JSON.stringify({ status: "OK", data_str: "not-valid-json" })),
        json: vi.fn().mockRejectedValue(new Error("not called")),
      }),
    };

    const input = GetSystemPropertiesSchema.parse({});
    const result = await getSystemProperties(session, input);

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

    const input = GetSystemPropertiesSchema.parse({});
    const result = await getSystemProperties(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Connection refused");
    }
  });

  it("returns empty array when category filter matches nothing", async () => {
    const session = makeSession(FULL_PROPERTY_MAP);

    const input = GetSystemPropertiesSchema.parse({ category: "nonexistent" });
    const result = await getSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
      expect(result.rowCount).toBe(0);
    }
  });
});
