import { describe, it, expect, vi } from "vitest";
import { ResourceObjectsSchema, getResourceObjects } from "./resource-objects.js";
import type { KineticaSession } from "../../types/index.js";

// resource-objects.ts does not exist yet — these tests define the expected contract
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
    rank_objects: {
      rank_0: {
        "orders.data": { tier: "VRAM", size_bytes: 1048576 },
      },
    },
  }),
};

// ---- Schema validation ----

describe("ResourceObjectsSchema", () => {
  it("accepts empty object with defaults", () => {
    const result = ResourceObjectsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.table_names).toBe("*");
      expect(result.data.limit).toBe(100);
    }
  });

  it("accepts table_names string", () => {
    const result = ResourceObjectsSchema.safeParse({ table_names: "orders" });
    expect(result.success).toBe(true);
  });

  it("accepts tiers string", () => {
    const result = ResourceObjectsSchema.safeParse({ tiers: "VRAM,RAM" });
    expect(result.success).toBe(true);
  });

  it("accepts order_by string", () => {
    const result = ResourceObjectsSchema.safeParse({ order_by: "size_bytes" });
    expect(result.success).toBe(true);
  });

  it("accepts valid limit number", () => {
    const result = ResourceObjectsSchema.safeParse({ limit: 500 });
    expect(result.success).toBe(true);
  });

  it("rejects limit below 1", () => {
    const result = ResourceObjectsSchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects limit above 10000", () => {
    const result = ResourceObjectsSchema.safeParse({ limit: 10001 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer limit", () => {
    const result = ResourceObjectsSchema.safeParse({ limit: 1.5 });
    expect(result.success).toBe(false);
  });
});

// ---- getResourceObjects function ----

describe("getResourceObjects", () => {
  it("returns ok:true with data_str on 200 response", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ResourceObjectsSchema.parse({});
    const result = await getResourceObjects(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { rank_objects: unknown };
      expect(data.rank_objects).toBeDefined();
    }
  });

  it("calls /show/resource/objects with correct default options", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ResourceObjectsSchema.parse({});
    await getResourceObjects(session, input);

    expect(session.makeRequest).toHaveBeenCalledWith("/show/resource/objects", {
      options: {
        table_names: "*",
        limit: "100",
      },
    });
  });

  it("includes tiers in options when specified", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ResourceObjectsSchema.parse({ tiers: "VRAM,RAM" });
    await getResourceObjects(session, input);

    const callArgs = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = callArgs[1] as { options: Record<string, string> };
    expect(body.options.tiers).toBe("VRAM,RAM");
  });

  it("includes order_by in options when specified", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ResourceObjectsSchema.parse({ order_by: "size_bytes" });
    await getResourceObjects(session, input);

    const callArgs = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = callArgs[1] as { options: Record<string, string> };
    expect(body.options.order_by).toBe("size_bytes");
  });

  it("does not include tiers when not specified", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ResourceObjectsSchema.parse({});
    await getResourceObjects(session, input);

    const callArgs = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = callArgs[1] as { options: Record<string, string> };
    expect(body.options).not.toHaveProperty("tiers");
    expect(body.options).not.toHaveProperty("order_by");
  });

  it("converts limit to string in options", async () => {
    const session = makeSession(SAMPLE_RESPONSE);
    const input = ResourceObjectsSchema.parse({ limit: 250 });
    await getResourceObjects(session, input);

    const callArgs = (session.makeRequest as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = callArgs[1] as { options: Record<string, string> };
    expect(body.options.limit).toBe("250");
  });

  it("returns ok:false with status on non-200 response", async () => {
    const session = makeSession(null, 503);
    const input = ResourceObjectsSchema.parse({});
    const result = await getResourceObjects(session, input);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toBe("HTTP 503");
    }
  });

  it("returns ok:false with parse error on invalid JSON", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })),
    };

    const input = ResourceObjectsSchema.parse({});
    const result = await getResourceObjects(session, input);

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

    const input = ResourceObjectsSchema.parse({});
    const result = await getResourceObjects(session, input);

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

    const input = ResourceObjectsSchema.parse({});
    await expect(getResourceObjects(session, input)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Connection refused"),
    });
  });
});
