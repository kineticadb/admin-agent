import { describe, it, expect, vi } from "vitest";
import { AlterConfigurationSchema, alterConfiguration } from "./alter-configuration.js";
import type { KineticaSession } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BEFORE_CONFIG = "[gpudb]\nenable_audit = false\nworker_endpoint_threads = 8\n";
const AFTER_CONFIG = "[gpudb]\nenable_audit = true\nworker_endpoint_threads = 8\n";

/**
 * Build a data_str-encoded response body for host manager endpoints.
 */
function makeDataStrBody(inner: Record<string, unknown>): string {
  return JSON.stringify({ data_str: JSON.stringify(inner) });
}

/**
 * Build a mock showConfiguration response body (for before/after reads).
 */
function makeShowConfigBody(configString: string): string {
  return makeDataStrBody({ config_string: configString, info: {} });
}

/**
 * Build a mock alterConfiguration response body.
 */
function makeAlterResponseBody(): string {
  return makeDataStrBody({ config_string: "", info: {} });
}

/**
 * Create a session mock that handles the full three-phase lifecycle:
 *   1. makeRequest (port discovery for before-read) → fails (fallback to 9300)
 *   2. makeRequestToPort (before showConfiguration) → returns beforeConfig
 *   3. makeRequest (port discovery for mutation) → fails (fallback to 9300)
 *   4. makeRequestToPort (alter mutation) → returns alter response
 *   5. makeRequest (port discovery for after-read) → fails (fallback to 9300)
 *   6. makeRequestToPort (after showConfiguration) → returns afterConfig
 */
function makeFullSession(opts: {
  beforeConfig?: string;
  afterConfig?: string;
  alterOk?: boolean;
  alterStatus?: number;
  alterBody?: string;
}): KineticaSession {
  const {
    beforeConfig = BEFORE_CONFIG,
    afterConfig = AFTER_CONFIG,
    alterOk = true,
    alterStatus = 200,
    alterBody = makeAlterResponseBody(),
  } = opts;

  // makeRequest always fails → discoverHmPort falls back to 9300
  const makeRequest = vi.fn().mockResolvedValue({
    ok: false,
    status: 500,
    text: vi.fn().mockResolvedValue(""),
  });

  // makeRequestToPort: sequence of calls
  // Call 1: before showConfiguration
  // Call 2: alter mutation
  // Call 3: after showConfiguration
  const makeRequestToPort = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(makeShowConfigBody(beforeConfig)),
    })
    .mockResolvedValueOnce({
      ok: alterOk,
      status: alterStatus,
      text: vi.fn().mockResolvedValue(alterBody),
    })
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(makeShowConfigBody(afterConfig)),
    });

  return {
    makeRequest,
    makeRequestToPort,
    baseUrl: "http://localhost:9191",
  };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("AlterConfigurationSchema", () => {
  it("accepts valid non-empty config_string", () => {
    const result = AlterConfigurationSchema.safeParse({ config_string: AFTER_CONFIG });
    expect(result.success).toBe(true);
  });

  it("rejects empty config_string", () => {
    const result = AlterConfigurationSchema.safeParse({ config_string: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing config_string", () => {
    const result = AlterConfigurationSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Three-phase lifecycle
// ---------------------------------------------------------------------------

describe("alterConfiguration", () => {
  it("returns ok:true with verification:confirmed when config changed", async () => {
    const session = makeFullSession({
      beforeConfig: BEFORE_CONFIG,
      afterConfig: AFTER_CONFIG,
    });

    const result = await alterConfiguration(session, { config_string: AFTER_CONFIG });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verification).toBe("confirmed");
      expect(result.data.before_summary.line_count).toBeGreaterThan(0);
      expect(result.data.after_summary.line_count).toBeGreaterThan(0);
    }
  });

  it("returns verification:failed when before and after configs are identical", async () => {
    const session = makeFullSession({
      beforeConfig: BEFORE_CONFIG,
      afterConfig: BEFORE_CONFIG, // same as before
    });

    const result = await alterConfiguration(session, { config_string: BEFORE_CONFIG });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verification).toBe("failed");
    }
  });

  it("returns verification:unavailable when post-mutation read fails", async () => {
    const makeRequest = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue(""),
    });

    const makeRequestToPort = vi
      .fn()
      // Before read: success
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(makeShowConfigBody(BEFORE_CONFIG)),
      })
      // Alter mutation: success
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(makeAlterResponseBody()),
      })
      // After read: failure
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue("Internal Server Error"),
      });

    const session = {
      makeRequest,
      makeRequestToPort,
      baseUrl: "http://localhost:9191",
    } as unknown as KineticaSession;

    const result = await alterConfiguration(session, { config_string: AFTER_CONFIG });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verification).toBe("unavailable");
    }
  });

  it("before-state failure does NOT block mutation", async () => {
    const makeRequest = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue(""),
    });

    const makeRequestToPort = vi
      .fn()
      // Before read: failure
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue("Error"),
      })
      // Alter mutation: success
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(makeAlterResponseBody()),
      })
      // After read: success
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(makeShowConfigBody(AFTER_CONFIG)),
      });

    const session = {
      makeRequest,
      makeRequestToPort,
      baseUrl: "http://localhost:9191",
    } as unknown as KineticaSession;

    const result = await alterConfiguration(session, { config_string: AFTER_CONFIG });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Before-state unavailable, so verification is unavailable
      expect(result.data.verification).toBe("unavailable");
      expect(result.data.before_summary.line_count).toBe(0);
      expect(result.data.after_summary.line_count).toBeGreaterThan(0);
    }
  });

  it("calls /admin/alter/configuration with config_string on HM port", async () => {
    const session = makeFullSession({});

    await alterConfiguration(session, { config_string: AFTER_CONFIG });

    // Second call to makeRequestToPort is the mutation
    expect(session.makeRequestToPort).toHaveBeenCalledWith(9300, "/admin/alter/configuration", {
      config_string: AFTER_CONFIG,
    });
  });

  it("before_summary and after_summary contain line_count and preview", async () => {
    const session = makeFullSession({
      beforeConfig: BEFORE_CONFIG,
      afterConfig: AFTER_CONFIG,
    });

    const result = await alterConfiguration(session, { config_string: AFTER_CONFIG });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.data.before_summary.line_count).toBe("number");
      expect(typeof result.data.before_summary.preview).toBe("string");
      expect(typeof result.data.after_summary.line_count).toBe("number");
      expect(typeof result.data.after_summary.preview).toBe("string");
    }
  });

  it("preview contains first 20 lines of config", async () => {
    // Create a config with 30 lines
    const longConfig = Array.from({ length: 30 }, (_, i) => `line_${i + 1} = value`).join("\n");
    const session = makeFullSession({
      beforeConfig: longConfig,
      afterConfig: longConfig + "\nextra = true",
    });

    const result = await alterConfiguration(session, {
      config_string: longConfig + "\nextra = true",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Preview should have at most 20 lines
      const previewLines = result.data.before_summary.preview.split("\n");
      expect(previewLines.length).toBeLessThanOrEqual(20);
      expect(result.data.before_summary.line_count).toBe(30);
    }
  });

  // ---------------------------------------------------------------------------
  // Error paths
  // ---------------------------------------------------------------------------

  it("returns ok:false when makeRequestToPort is not available", async () => {
    const session: KineticaSession = {
      makeRequest: vi.fn(),
      baseUrl: "http://localhost:9191",
    };

    const result = await alterConfiguration(session, { config_string: AFTER_CONFIG });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("makeRequestToPort not available");
    }
  });

  it("returns ok:false on non-200 HTTP response from mutation", async () => {
    const session = makeFullSession({
      alterOk: false,
      alterStatus: 500,
      alterBody: "Internal Server Error",
    });

    const result = await alterConfiguration(session, { config_string: AFTER_CONFIG });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
    }
  });

  it("returns ok:false on invalid JSON from mutation response", async () => {
    const session = makeFullSession({
      alterBody: "not valid json",
    });

    const result = await alterConfiguration(session, { config_string: AFTER_CONFIG });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("JSON parse error");
    }
  });

  it("returns ok:false on network error during mutation", async () => {
    const makeRequest = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue(""),
    });

    const makeRequestToPort = vi
      .fn()
      // Before read: success
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: vi.fn().mockResolvedValue(makeShowConfigBody(BEFORE_CONFIG)),
      })
      // Alter mutation: network error
      .mockRejectedValueOnce(new Error("Connection reset"));

    const session = {
      makeRequest,
      makeRequestToPort,
      baseUrl: "http://localhost:9191",
    } as unknown as KineticaSession;

    const result = await alterConfiguration(session, { config_string: AFTER_CONFIG });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Connection reset");
    }
  });

  it("never throws", async () => {
    const session: KineticaSession = {
      makeRequest: vi.fn().mockRejectedValue(new Error("boom")),
      makeRequestToPort: vi.fn().mockRejectedValue(new Error("boom")),
      baseUrl: "http://localhost:9191",
    };

    // Should not throw — returns ok:false instead
    const result = await alterConfiguration(session, { config_string: AFTER_CONFIG });
    expect(result.ok).toBe(false);
  });
});
