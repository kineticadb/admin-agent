import { describe, it, expect, vi } from "vitest";
import { GetLogsSchema, getLogs } from "./logs.js";
import type { KineticaSession } from "../../types/index.js";

// ---- GetLogsSchema validation ----

describe("GetLogsSchema", () => {
  describe("valid inputs", () => {
    it("accepts a valid source with limit", () => {
      const result = GetLogsSchema.safeParse({ source: "kinetica", limit: 100 });
      expect(result.success).toBe(true);
    });

    it("accepts source with relative duration", () => {
      const result = GetLogsSchema.safeParse({ source: "rank", duration: "1h" });
      expect(result.success).toBe(true);
    });

    it("accepts source with absolute start_time and end_time", () => {
      const result = GetLogsSchema.safeParse({
        source: "syslog",
        start_time: "2024-01-01T00:00:00Z",
        end_time: "2024-01-02T00:00:00Z",
      });
      expect(result.success).toBe(true);
    });

    it("accepts all valid sources", () => {
      const sources = ["kinetica", "rank", "syslog", "gadmin", "reveal", "workbench"] as const;
      for (const source of sources) {
        const result = GetLogsSchema.safeParse({ source });
        expect(result.success).toBe(true);
      }
    });

    it("accepts all valid severity levels", () => {
      const levels = ["DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;
      for (const level of levels) {
        const result = GetLogsSchema.safeParse({ source: "kinetica", min_severity: level });
        expect(result.success).toBe(true);
      }
    });

    it("applies default min_severity of INFO", () => {
      const result = GetLogsSchema.safeParse({ source: "kinetica" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.min_severity).toBe("INFO");
      }
    });

    it("applies default limit of 500", () => {
      const result = GetLogsSchema.safeParse({ source: "kinetica" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(500);
      }
    });

    it("accepts optional node_id", () => {
      const result = GetLogsSchema.safeParse({ source: "kinetica", node_id: "node-0" });
      expect(result.success).toBe(true);
    });

    it("accepts duration with minutes (m)", () => {
      const result = GetLogsSchema.safeParse({ source: "kinetica", duration: "30m" });
      expect(result.success).toBe(true);
    });

    it("accepts duration with days (d)", () => {
      const result = GetLogsSchema.safeParse({ source: "kinetica", duration: "7d" });
      expect(result.success).toBe(true);
    });
  });

  describe("invalid inputs", () => {
    it("rejects unknown source", () => {
      const result = GetLogsSchema.safeParse({ source: "unknown" });
      expect(result.success).toBe(false);
    });

    it("rejects invalid duration format (week not supported)", () => {
      const result = GetLogsSchema.safeParse({ source: "kinetica", duration: "1week" });
      expect(result.success).toBe(false);
    });

    it("rejects duration with no unit", () => {
      const result = GetLogsSchema.safeParse({ source: "kinetica", duration: "60" });
      expect(result.success).toBe(false);
    });

    it("rejects duration and start_time together (mutually exclusive)", () => {
      const result = GetLogsSchema.safeParse({
        source: "kinetica",
        duration: "1h",
        start_time: "2024-01-01T00:00:00Z",
      });
      expect(result.success).toBe(false);
    });

    it("rejects duration and end_time together (mutually exclusive)", () => {
      const result = GetLogsSchema.safeParse({
        source: "kinetica",
        duration: "1h",
        end_time: "2024-01-01T00:00:00Z",
      });
      expect(result.success).toBe(false);
    });

    it("rejects limit below 1", () => {
      const result = GetLogsSchema.safeParse({ source: "kinetica", limit: 0 });
      expect(result.success).toBe(false);
    });

    it("rejects limit above 5000", () => {
      const result = GetLogsSchema.safeParse({ source: "kinetica", limit: 5001 });
      expect(result.success).toBe(false);
    });

    it("rejects unknown severity level", () => {
      const result = GetLogsSchema.safeParse({ source: "kinetica", min_severity: "TRACE" });
      expect(result.success).toBe(false);
    });
  });
});

// ---- getLogs function (rewritten for /admin/show/logs) ----

function makeSession(response: Partial<Response>): KineticaSession {
  return {
    baseUrl: "http://localhost:9191",
    makeRequest: vi.fn().mockResolvedValue(response),
  };
}

describe("getLogs", () => {
  it("returns ok:true with parsed data on 200 response", async () => {
    const mockData = { entries: [{ message: "Server started", severity: "INFO" }] };
    const session = makeSession({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(mockData),
      text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
    });

    const input = GetLogsSchema.parse({ source: "kinetica" });
    const result = await getLogs(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(mockData);
    }
  });

  it("calls makeRequest with /admin/show/logs endpoint", async () => {
    const mockData = { entries: [] };
    const session = makeSession({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(mockData),
      text: vi.fn().mockResolvedValue(JSON.stringify(mockData)),
    });

    const input = GetLogsSchema.parse({ source: "kinetica", duration: "30m", limit: 100 });
    await getLogs(session, input);

    expect(session.makeRequest).toHaveBeenCalledWith("/admin/show/logs", expect.any(Object));
  });

  it("returns ok:true with stub on 404 (endpoint not yet implemented)", async () => {
    const session = makeSession({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue("Not Found"),
    });

    const input = GetLogsSchema.parse({ source: "kinetica", duration: "1h" });
    const result = await getLogs(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data.note).toContain("not yet implemented");
      expect(data.endpoint).toBe("/admin/show/logs");
      expect(data.status).toBe("stub");
    }
  });

  it("returns ok:true with stub on 401 auth failure", async () => {
    const session = makeSession({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue("Unauthorized"),
    });

    const input = GetLogsSchema.parse({ source: "gadmin" });
    const result = await getLogs(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data.note).toContain("not yet implemented");
      expect(data.status).toBe("stub");
    }
  });

  it("returns ok:true with stub on JSON parse error for 200 response", async () => {
    const session = makeSession({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
      text: vi.fn().mockResolvedValue("not-json-payload"),
    });

    const input = GetLogsSchema.parse({ source: "rank" });
    const result = await getLogs(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data.note).toContain("not yet implemented");
      expect(data.status).toBe("stub");
    }
  });

  it("returns ok:true with stub on network error", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockRejectedValue(new Error("Network error")),
    };

    const input = GetLogsSchema.parse({ source: "kinetica" });
    const result = await getLogs(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data.note).toContain("not yet implemented");
      expect(data.status).toBe("stub");
    }
  });

  it("stub includes requested_params with source and min_severity", async () => {
    const session = makeSession({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue("Not Found"),
    });

    const input = GetLogsSchema.parse({ source: "rank", min_severity: "ERROR", duration: "2h" });
    const result = await getLogs(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      const params = data.requested_params as Record<string, unknown>;
      expect(params.source).toBe("rank");
      expect(params.min_severity).toBe("ERROR");
      expect(params.duration).toBe("2h");
    }
  });

  it("stub note mentions kinetica_execute_sql as alternative", async () => {
    const session = makeSession({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue("Not Found"),
    });

    const input = GetLogsSchema.parse({ source: "kinetica" });
    const result = await getLogs(session, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data.note).toContain("kinetica_execute_sql");
    }
  });
});
