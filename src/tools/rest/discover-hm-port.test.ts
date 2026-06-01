import { describe, it, expect, vi } from "vitest";
import { discoverHmPort, DEFAULT_HM_PORT } from "./discover-hm-port.js";
import type { KineticaSession } from "../../types/index.js";

function makeSession(propertyRows: ReadonlyArray<Record<string, string>>): KineticaSession {
  const dataStr = JSON.stringify({
    property_map: Object.fromEntries(propertyRows.map((r) => [r.property, r.value])),
  });
  return {
    makeRequest: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(JSON.stringify({ data_str: dataStr })),
    }),
    baseUrl: "http://localhost:9191",
  };
}

describe("discoverHmPort", () => {
  it("returns discovered port from system properties", async () => {
    const session = makeSession([{ property: "conf.hm_http_port", value: "9301" }]);
    const port = await discoverHmPort(session);
    expect(port).toBe(9301);
  });

  it("falls back to DEFAULT_HM_PORT when system properties lookup fails", async () => {
    const session = {
      makeRequest: vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue("Internal Server Error"),
      }),
      baseUrl: "http://localhost:9191",
    } as unknown as KineticaSession;

    const port = await discoverHmPort(session);
    expect(port).toBe(DEFAULT_HM_PORT);
  });

  it("falls back to DEFAULT_HM_PORT when hm_http_port value is not a number", async () => {
    const session = makeSession([{ property: "conf.hm_http_port", value: "not-a-number" }]);
    const port = await discoverHmPort(session);
    expect(port).toBe(DEFAULT_HM_PORT);
  });

  it("falls back to DEFAULT_HM_PORT when property entry has no value", async () => {
    const session = makeSession([{ property: "conf.hm_http_port", value: "" }]);
    const port = await discoverHmPort(session);
    expect(port).toBe(DEFAULT_HM_PORT);
  });

  it("falls back to DEFAULT_HM_PORT when hm_http_port property is absent", async () => {
    const session = makeSession([{ property: "conf.some_other_key", value: "9301" }]);
    const port = await discoverHmPort(session);
    expect(port).toBe(DEFAULT_HM_PORT);
  });

  it("never throws — returns default on network error", async () => {
    const session = {
      makeRequest: vi.fn().mockRejectedValue(new Error("Connection refused")),
      baseUrl: "http://localhost:9191",
    } as unknown as KineticaSession;

    const port = await discoverHmPort(session);
    expect(port).toBe(DEFAULT_HM_PORT);
  });

  it("DEFAULT_HM_PORT is 9300", () => {
    expect(DEFAULT_HM_PORT).toBe(9300);
  });
});
