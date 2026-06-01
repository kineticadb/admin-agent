import { describe, it, expect, vi } from "vitest";
import { systemTiming } from "./system-timing.js";
import type { KineticaSession } from "../../types/index.js";

// system-timing.ts does not exist yet — these tests define the expected contract
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

describe("systemTiming", () => {
  it("returns ok:true with zipped array on 200 response", async () => {
    const session = makeSession({
      status: "OK",
      data_str: JSON.stringify({
        endpoints: ["/show/system/status", "/execute/sql"],
        time_in_ms: [12, 45],
        jobIds: ["job_1", "job_2"],
      }),
    });

    const result = await systemTiming(session);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([
        { endpoint: "/show/system/status", time_in_ms: 12, job_id: "job_1" },
        { endpoint: "/execute/sql", time_in_ms: 45, job_id: "job_2" },
      ]);
    }
  });

  it("calls /show/system/timing with options:{}", async () => {
    const session = makeSession({
      status: "OK",
      data_str: JSON.stringify({ endpoints: [], time_in_ms: [], jobIds: [] }),
    });

    await systemTiming(session);

    expect(session.makeRequest).toHaveBeenCalledWith("/show/system/timing", { options: {} });
  });

  it("returns ok:true with empty array when data_str arrays are missing", async () => {
    const session = makeSession({
      status: "OK",
      data_str: JSON.stringify({}),
    });

    const result = await systemTiming(session);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([]);
    }
  });

  it("returns ok:false with status and raw on non-200 response", async () => {
    const session = makeSession(null, 503);

    const result = await systemTiming(session);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toBe("HTTP 503");
    }
  });

  it("returns ok:false with parse error on invalid JSON body", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })),
    };

    const result = await systemTiming(session);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(200);
      expect(result.error).toMatch(/JSON parse error/);
      expect(result.raw).toBe("not-json");
    }
  });

  it("returns ok:false when data_str is a malformed JSON string", async () => {
    const session = makeSession({
      status: "OK",
      data_str: "not-valid-json",
    });

    const result = await systemTiming(session);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/data_str parse error/);
    }
  });

  it("never throws — network errors return ok:false", async () => {
    const session: KineticaSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn().mockRejectedValue(new Error("Network failure")),
    };

    await expect(systemTiming(session)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Network failure"),
    });
  });
});
