import { describe, it, expect, vi } from "vitest";
import { ShowConfigurationSchema, showConfiguration } from "./show-configuration.js";
import type { KineticaSession } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLE_CONFIG = "[gpudb]\nenable_audit = false\nworker_endpoint_threads = 8\n";

function makeHmSession(hmResponse: { ok: boolean; status: number; body: string }): KineticaSession {
  // makeRequest is needed for discoverHmPort → getSystemProperties
  // Return a failure so it falls back to default port 9300
  return {
    makeRequest: vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue(""),
    }),
    makeRequestToPort: vi.fn().mockResolvedValue({
      ok: hmResponse.ok,
      status: hmResponse.status,
      text: vi.fn().mockResolvedValue(hmResponse.body),
    }),
    baseUrl: "http://localhost:9191",
  };
}

function makeSuccessBody(configString: string): string {
  const inner = JSON.stringify({ config_string: configString, info: {} });
  return JSON.stringify({
    status: "OK",
    message: "",
    data_type: "admin_show_configuration_response",
    data: "",
    data_str: inner,
  });
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("ShowConfigurationSchema", () => {
  it("accepts empty object", () => {
    const result = ShowConfigurationSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// showConfiguration function
// ---------------------------------------------------------------------------

describe("showConfiguration", () => {
  it("returns ok:true with config_string and info on successful 200 response", async () => {
    const session = makeHmSession({
      ok: true,
      status: 200,
      body: makeSuccessBody(SAMPLE_CONFIG),
    });

    const result = await showConfiguration(session, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.config_string).toBe(SAMPLE_CONFIG);
      expect(result.data.info).toEqual({});
    }
  });

  it("calls /admin/show/configuration on the discovered HM port", async () => {
    const session = makeHmSession({
      ok: true,
      status: 200,
      body: makeSuccessBody(SAMPLE_CONFIG),
    });

    await showConfiguration(session, {});

    expect(session.makeRequestToPort).toHaveBeenCalledWith(9300, "/admin/show/configuration", {});
  });

  it("returns ok:false when makeRequestToPort is not available", async () => {
    const session: KineticaSession = {
      makeRequest: vi.fn(),
      baseUrl: "http://localhost:9191",
    };

    const result = await showConfiguration(session, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("makeRequestToPort not available");
    }
  });

  it("returns ok:false on non-200 HTTP response", async () => {
    const session = makeHmSession({
      ok: false,
      status: 503,
      body: "Service Unavailable",
    });

    const result = await showConfiguration(session, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toContain("503");
    }
  });

  it("returns ok:false on network error", async () => {
    const session: KineticaSession = {
      makeRequest: vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue(""),
      }),
      makeRequestToPort: vi.fn().mockRejectedValue(new Error("Connection refused")),
      baseUrl: "http://localhost:9191",
    };

    const result = await showConfiguration(session, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Connection refused");
    }
  });

  it("returns ok:false on malformed outer JSON", async () => {
    const session = makeHmSession({
      ok: true,
      status: 200,
      body: "not valid json",
    });

    const result = await showConfiguration(session, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("JSON parse error");
    }
  });

  it("returns ok:false on malformed data_str", async () => {
    const session = makeHmSession({
      ok: true,
      status: 200,
      body: JSON.stringify({ data_str: "not-valid-json" }),
    });

    const result = await showConfiguration(session, {});

    expect(result.ok).toBe(false);
  });

  it("redacts secret values in config_string before returning to the agent", async () => {
    const secretConfig = [
      "[gpudb]",
      "license_key = TRIAL-9F3A-22BC-7E10-PROD",
      "security.ldap_bind_password = MyDirectoryPassw0rd",
      "ssl_keystore_password = keystorePass!",
      "worker_endpoint_threads = 8",
    ].join("\n");
    const session = makeHmSession({
      ok: true,
      status: 200,
      body: makeSuccessBody(secretConfig),
    });

    const result = await showConfiguration(session, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Secrets must never enter the agent context.
      expect(result.data.config_string).not.toContain("TRIAL-9F3A-22BC-7E10-PROD");
      expect(result.data.config_string).not.toContain("MyDirectoryPassw0rd");
      expect(result.data.config_string).not.toContain("keystorePass!");
      // Keys and non-secret values are preserved for drift diagnosis.
      expect(result.data.config_string).toContain("license_key = [REDACTED]");
      expect(result.data.config_string).toContain("worker_endpoint_threads = 8");
    }
  });

  it("returns empty config_string when inner data has no config_string field", async () => {
    const inner = JSON.stringify({ info: { note: "empty" } });
    const session = makeHmSession({
      ok: true,
      status: 200,
      body: JSON.stringify({ data_str: inner }),
    });

    const result = await showConfiguration(session, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.config_string).toBe("");
      expect(result.data.info).toEqual({ note: "empty" });
    }
  });

  it("never throws", async () => {
    const session: KineticaSession = {
      makeRequest: vi.fn().mockRejectedValue(new Error("boom")),
      makeRequestToPort: vi.fn().mockRejectedValue(new Error("boom")),
      baseUrl: "http://localhost:9191",
    };

    // Should not throw — returns ok:false instead
    const result = await showConfiguration(session, {});
    expect(result.ok).toBe(false);
  });
});
