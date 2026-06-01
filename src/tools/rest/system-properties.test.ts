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

const FULL_PROPERTY_MAP = {
  "memory.shared": "8192",
  "memory.limit": "16384",
  "memory.swap": "4096",
  "gpu.count": "4",
  "gpu.memory": "32768",
  "GPU.enabled": "true",
  "system.threads": "32",
  "network.timeout": "30",
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
      expect(data[0]).toEqual({ property: "memory.shared", value: "8192" });
      expect(data).toContainEqual({ property: "gpu.count", value: "4" });
      expect(result.rowCount).toBe(Object.keys(FULL_PROPERTY_MAP).length);
    }
  });

  it("filters property_map by category prefix", async () => {
    const session = makeSession(FULL_PROPERTY_MAP);

    const input = GetSystemPropertiesSchema.parse({ category: "memory" });
    const result = await getSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Array<Record<string, string>>;
      const properties = data.map((r) => r.property);
      expect(properties).toEqual(
        expect.arrayContaining(["memory.shared", "memory.limit", "memory.swap"]),
      );
      expect(properties).not.toContain("gpu.count");
      expect(properties).not.toContain("system.threads");
    }
  });

  it("filters property_map by category prefix starting with 'mem'", async () => {
    const session = makeSession(FULL_PROPERTY_MAP);

    const input = GetSystemPropertiesSchema.parse({ category: "mem" });
    const result = await getSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Array<Record<string, string>>;
      expect(data).toHaveLength(3);
      const properties = data.map((r) => r.property);
      expect(properties).toEqual(
        expect.arrayContaining(["memory.shared", "memory.limit", "memory.swap"]),
      );
    }
  });

  it("filters property_map by key_pattern (case-insensitive substring)", async () => {
    const session = makeSession(FULL_PROPERTY_MAP);

    const input = GetSystemPropertiesSchema.parse({ key_pattern: "gpu" });
    const result = await getSystemProperties(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Array<Record<string, string>>;
      const properties = data.map((r) => r.property);
      // Both "gpu.count" and "GPU.enabled" should match (case-insensitive)
      expect(properties).toEqual(
        expect.arrayContaining(["gpu.count", "gpu.memory", "GPU.enabled"]),
      );
      expect(properties).not.toContain("memory.shared");
      expect(properties).not.toContain("system.threads");
    }
  });

  it("returns correct rowCount for filtered results", async () => {
    const session = makeSession(FULL_PROPERTY_MAP);

    const input = GetSystemPropertiesSchema.parse({ category: "memory" });
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
