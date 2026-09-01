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

  // The vocabulary above is the pre-2026-09 set. These are the keys a real
  // gpudb.conf also carries that an enumerated license_key|private_key rule
  // missed, plus the policy/flag keys that must stay readable — a redaction test
  // whose fixture holds only secrets cannot catch over-redaction.
  it("redacts cloud-storage and API credentials a bare key-word list misses", async () => {
    const secretConfig = [
      "[gpudb]",
      "ai.api.key = sk-live-abc123",
      "external_authentication_handshake_key = hs-secret-xyz",
      "tier.cold0.default.s3_aws_access_key_id = AKIAEXAMPLE",
      "tier.cold0.default.s3_aws_secret_access_key = wJalrXUtnFEMI",
      "tier.cold0.default.azure_sas_token = sv=2020-signature",
      "tier.cold0.default.gcs_service_account_private_key = MIIEvQIBADAN",
    ].join("\n");
    const session = makeHmSession({ ok: true, status: 200, body: makeSuccessBody(secretConfig) });

    const result = await showConfiguration(session, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      const cs = result.data.config_string;
      expect(cs).not.toMatch(/sk-live-abc123|hs-secret-xyz|AKIAEXAMPLE|wJalrXUtnFEMI|MIIEvQIBADAN/);
      expect(cs).not.toContain("sv=2020-signature");
      expect(cs).toContain("ai.api.key = [REDACTED]");
    }
  });

  it("leaves policy, flag and path values readable for diagnosis", async () => {
    const config = [
      "[gpudb]",
      "min_password_length = 0",
      "tier.cold0.default.use_managed_credentials = false",
      "postgres_proxy.ssl_key_file = /etc/ssl/private/pg.key",
      "https_cert_file = /etc/ssl/certs/kinetica.pem",
      "tps_per_tom = 4",
    ].join("\n");
    const session = makeHmSession({ ok: true, status: 200, body: makeSuccessBody(config) });

    const result = await showConfiguration(session, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.config_string).not.toContain("[REDACTED]");
      expect(result.data.config_string).toContain("/etc/ssl/private/pg.key");
      expect(result.data.config_string).toContain("min_password_length = 0");
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
