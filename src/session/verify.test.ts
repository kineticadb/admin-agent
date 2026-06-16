import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { KineticaSession } from "../types/index.js";

// Mock the dependencies of verify.ts
vi.mock("./collect.js", () => ({
  collectCredentials: vi.fn(),
  repromptCredentials: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn(),
}));

vi.mock("./KineticaSession.js", () => ({
  createSession: vi.fn(),
}));

vi.mock("./env-file.js", () => ({
  offerSaveCredentials: vi.fn(),
}));

vi.mock("./resolve-url.js", () => ({
  resolveUrl: vi.fn(),
}));

// Mock picocolors so we can test colored output without ANSI codes
vi.mock("picocolors", () => ({
  default: {
    green: (s: string) => `GREEN(${s})`,
    red: (s: string) => `RED(${s})`,
    yellow: (s: string) => `YELLOW(${s})`,
  },
}));

import { collectCredentials, repromptCredentials } from "./collect.js";
import { createSession } from "./KineticaSession.js";
import { offerSaveCredentials } from "./env-file.js";
import { resolveUrl } from "./resolve-url.js";
import { confirm } from "@inquirer/prompts";
import {
  verifyConnectivity,
  connectWithRetry,
  connectBestEffort,
  extractVersion,
  extractVersionFromHostManager,
  probeHostManager,
  isCredentialError,
} from "./verify.js";

const mockCollectCredentials = collectCredentials as ReturnType<typeof vi.fn>;
const mockReprompt = repromptCredentials as ReturnType<typeof vi.fn>;
const mockCreateSession = createSession as ReturnType<typeof vi.fn>;
const mockOfferSave = offerSaveCredentials as ReturnType<typeof vi.fn>;
const mockResolveUrl = resolveUrl as ReturnType<typeof vi.fn>;
const mockConfirm = confirm as unknown as ReturnType<typeof vi.fn>;

/** Helper: build a CollectResult with no prompted fields (all from env). */
function makeCollectResult(
  url = "http://kinetica:9191",
  user = "admin",
  pass = "secret",
  prompted: ReadonlySet<"url" | "user"> = new Set(),
) {
  return { credentials: { url, user, pass }, prompted };
}

/** Build a /show/system/status response body with optional version. */
function makeStatusBody(version?: string): string {
  const systemObj = version
    ? JSON.stringify({ version, status: "running" })
    : JSON.stringify({ status: "running" });
  return JSON.stringify({
    data_str: JSON.stringify({ status_map: { system: systemObj } }),
  });
}

function makeSession(overrides: Partial<KineticaSession> = {}): KineticaSession {
  return {
    baseUrl: "http://kinetica:9191",
    makeRequest: vi
      .fn()
      .mockResolvedValue(new Response(makeStatusBody("7.2.3.11"), { status: 200 })),
    ...overrides,
  };
}

describe("extractVersion", () => {
  it("extracts version from valid /show/system/status response", () => {
    const body = makeStatusBody("7.2.3.11.20260317111832");
    expect(extractVersion(body)).toBe("7.2.3.11.20260317111832");
  });

  it("returns undefined for malformed JSON", () => {
    expect(extractVersion("not json")).toBeUndefined();
  });

  it("returns undefined when data_str is missing", () => {
    expect(extractVersion(JSON.stringify({}))).toBeUndefined();
  });

  it("returns undefined when status_map.system has no version", () => {
    const body = JSON.stringify({
      data_str: JSON.stringify({ status_map: { system: JSON.stringify({ status: "running" }) } }),
    });
    expect(extractVersion(body)).toBeUndefined();
  });

  it("returns undefined when data_str is not a string", () => {
    expect(extractVersion(JSON.stringify({ data_str: 42 }))).toBeUndefined();
  });

  it("returns undefined when system value is not valid JSON", () => {
    const body = JSON.stringify({
      data_str: JSON.stringify({ status_map: { system: "not-json" } }),
    });
    expect(extractVersion(body)).toBeUndefined();
  });
});

describe("verifyConnectivity", () => {
  it("returns version string when response contains version", async () => {
    const session = makeSession();
    const version = await verifyConnectivity(session);
    expect(version).toBe("7.2.3.11");
    expect(session.makeRequest).toHaveBeenCalledOnce();
  });

  it("returns undefined when response has no version", async () => {
    const session = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response(makeStatusBody(), { status: 200 })),
    });
    const version = await verifyConnectivity(session);
    expect(version).toBeUndefined();
  });

  it("throws when makeRequest returns non-ok response", async () => {
    const session = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    });
    await expect(verifyConnectivity(session)).rejects.toThrow();
  });

  it("includes status code in the error message on failure", async () => {
    const session = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 })),
    });
    await expect(verifyConnectivity(session)).rejects.toThrow("403");
  });

  it("calls makeRequest with health check endpoint", async () => {
    const session = makeSession();
    await verifyConnectivity(session);
    expect(session.makeRequest).toHaveBeenCalledWith("/show/system/status", {});
  });
});

describe("connectWithRetry", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockOfferSave.mockResolvedValue(undefined);
    // Default: resolveUrl passes through the collected URL unchanged
    mockResolveUrl.mockImplementation(async (url: string) => ({ ok: true, url }));
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("returns session and version on first successful attempt", async () => {
    const session = makeSession();
    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValue(session);

    const result = await connectWithRetry();

    expect(result.session).toBe(session);
    expect(result.kineticaVersion).toBe("7.2.3.11");
    expect(mockCollectCredentials).toHaveBeenCalledOnce();
    expect(mockCreateSession).toHaveBeenCalledOnce();
  });

  it("prints colored success message on connection", async () => {
    const session = makeSession();
    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValue(session);

    await connectWithRetry();

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("GREEN("));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Connected"));
  });

  it("retries on failure and succeeds on second attempt with same session", async () => {
    const mockMakeRequest = vi
      .fn()
      .mockResolvedValueOnce(new Response("error", { status: 500 }))
      .mockResolvedValueOnce(new Response(makeStatusBody("7.2.3.11"), { status: 200 }));
    const session = makeSession({ makeRequest: mockMakeRequest });

    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValue(session);

    const result = await connectWithRetry();

    expect(result.session).toBe(session);
    expect(mockCollectCredentials).toHaveBeenCalledOnce();
    expect(mockCreateSession).toHaveBeenCalledOnce();
    expect(mockMakeRequest).toHaveBeenCalledTimes(2);
  });

  it("prints colored failure message with attempt count on each failure", async () => {
    const mockMakeRequest = vi
      .fn()
      .mockResolvedValueOnce(new Response("error", { status: 500 }))
      .mockResolvedValueOnce(new Response(makeStatusBody("7.2.3.11"), { status: 200 }));
    const session = makeSession({ makeRequest: mockMakeRequest });

    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValue(session);

    await connectWithRetry();

    // First call should be failure message
    const errorCalls = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    const failureMessages = errorCalls.filter((m: string) => m.includes("RED("));
    expect(failureMessages.length).toBeGreaterThan(0);
    expect(failureMessages[0]).toContain("1/3");
  });

  it("exits with code 1 after 3 consecutive failures when HM also unreachable", async () => {
    const failSession = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
    });

    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValue(failSession);

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error("process.exit called");
      });

    try {
      await expect(connectWithRetry()).rejects.toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockCollectCredentials).toHaveBeenCalledOnce();
  });

  it("returns degraded:false on successful connection", async () => {
    const session = makeSession();
    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValue(session);

    const result = await connectWithRetry();
    expect(result.degraded).toBe(false);
  });

  it("returns degraded:true with HM version after 3 failed 9191 attempts + successful 9300", async () => {
    const hmResponse = JSON.stringify({ version: "7.2.3.11.hm", hostname: "host1" });
    const failSession = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
      makeRequestToPort: vi.fn().mockResolvedValue(new Response(hmResponse, { status: 200 })),
    });

    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValue(failSession);

    const result = await connectWithRetry();
    expect(result.degraded).toBe(true);
    expect(result.kineticaVersion).toBe("7.2.3.11.hm");
    expect(result.session).toBe(failSession);
  });

  it("prints yellow degraded mode banner when falling back to HM", async () => {
    const hmResponse = JSON.stringify({ version: "7.2.3.11", hostname: "host1" });
    const failSession = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
      makeRequestToPort: vi.fn().mockResolvedValue(new Response(hmResponse, { status: 200 })),
    });

    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValue(failSession);

    await connectWithRetry();

    const errorCalls = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    const yellowMessages = errorCalls.filter((m: string) => m.includes("YELLOW("));
    expect(yellowMessages.length).toBeGreaterThan(0);
    expect(yellowMessages.some((m: string) => m.includes("DEGRADED MODE"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // offerSaveCredentials integration
  // -------------------------------------------------------------------------

  it("offers to save when URL was prompted", async () => {
    const session = makeSession();
    mockCollectCredentials.mockResolvedValue(
      makeCollectResult("http://prompted:9191", "admin", "secret", new Set(["url"])),
    );
    mockCreateSession.mockReturnValue(session);

    await connectWithRetry();

    expect(mockOfferSave).toHaveBeenCalledOnce();
    expect(mockOfferSave).toHaveBeenCalledWith("http://prompted:9191", "admin");
  });

  it("offers to save when user was prompted", async () => {
    const session = makeSession();
    mockCollectCredentials.mockResolvedValue(
      makeCollectResult("http://kinetica:9191", "prompted-user", "secret", new Set(["user"])),
    );
    mockCreateSession.mockReturnValue(session);

    await connectWithRetry();

    expect(mockOfferSave).toHaveBeenCalledOnce();
    expect(mockOfferSave).toHaveBeenCalledWith("http://kinetica:9191", "prompted-user");
  });

  it("does not offer to save when nothing was prompted", async () => {
    const session = makeSession();
    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValue(session);

    await connectWithRetry();

    expect(mockOfferSave).not.toHaveBeenCalled();
  });

  it("offers to save in degraded mode when fields were prompted", async () => {
    const hmResponse = JSON.stringify({ version: "7.2.3.11", hostname: "host1" });
    const failSession = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
      makeRequestToPort: vi.fn().mockResolvedValue(new Response(hmResponse, { status: 200 })),
    });

    mockCollectCredentials.mockResolvedValue(
      makeCollectResult("http://prompted:9191", "admin", "secret", new Set(["url"])),
    );
    mockCreateSession.mockReturnValue(failSession);

    await connectWithRetry();

    expect(mockOfferSave).toHaveBeenCalledOnce();
    expect(mockOfferSave).toHaveBeenCalledWith("http://prompted:9191", "admin");
  });

  it("does not offer to save in degraded mode when nothing was prompted", async () => {
    const hmResponse = JSON.stringify({ version: "7.2.3.11", hostname: "host1" });
    const failSession = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
      makeRequestToPort: vi.fn().mockResolvedValue(new Response(hmResponse, { status: 200 })),
    });

    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValue(failSession);

    await connectWithRetry();

    expect(mockOfferSave).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // resolveUrl integration
  // -------------------------------------------------------------------------

  it("passes resolved URL to createSession", async () => {
    mockResolveUrl.mockResolvedValue({ ok: true, url: "https://resolved:9191" });
    const session = makeSession();
    mockCollectCredentials.mockResolvedValue(makeCollectResult("bare:9191"));
    mockCreateSession.mockReturnValue(session);

    await connectWithRetry();

    expect(mockCreateSession).toHaveBeenCalledWith("https://resolved:9191", "admin", "secret");
  });

  it("passes resolved URL to offerSaveCredentials", async () => {
    mockResolveUrl.mockResolvedValue({ ok: true, url: "https://resolved:9191" });
    const session = makeSession();
    mockCollectCredentials.mockResolvedValue(
      makeCollectResult("bare:9191", "admin", "secret", new Set(["url"])),
    );
    mockCreateSession.mockReturnValue(session);

    await connectWithRetry();

    expect(mockOfferSave).toHaveBeenCalledWith("https://resolved:9191", "admin");
  });

  it("passes resolved URL to offerSaveCredentials in degraded mode", async () => {
    mockResolveUrl.mockResolvedValue({ ok: true, url: "https://resolved:9191" });
    const hmResponse = JSON.stringify({ version: "7.2.3.11", hostname: "host1" });
    const failSession = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
      makeRequestToPort: vi.fn().mockResolvedValue(new Response(hmResponse, { status: 200 })),
    });

    mockCollectCredentials.mockResolvedValue(
      makeCollectResult("bare:9191", "admin", "secret", new Set(["url"])),
    );
    mockCreateSession.mockReturnValue(failSession);

    await connectWithRetry();

    expect(mockOfferSave).toHaveBeenCalledWith("https://resolved:9191", "admin");
  });

  it("exits with code 1 when resolveUrl returns ok:false", async () => {
    mockResolveUrl.mockResolvedValue({ ok: false, error: "Could not connect" });
    mockCollectCredentials.mockResolvedValue(makeCollectResult("bad-host:9191"));

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error("process.exit called");
      });

    try {
      await expect(connectWithRetry()).rejects.toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it("prints error message when resolveUrl returns ok:false", async () => {
    mockResolveUrl.mockResolvedValue({ ok: false, error: "Could not connect via https or http" });
    mockCollectCredentials.mockResolvedValue(makeCollectResult("bad-host:9191"));

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((_code?: number | string | null) => {
        throw new Error("process.exit called");
      });

    try {
      await expect(connectWithRetry()).rejects.toThrow("process.exit called");
    } finally {
      exitSpy.mockRestore();
    }

    const errorCalls = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(errorCalls.some((m: string) => m.includes("Could not connect"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isCredentialError
// ---------------------------------------------------------------------------

describe("isCredentialError", () => {
  it("returns true for HTTP 401", () => {
    expect(isCredentialError("HTTP 401: Unauthorized")).toBe(true);
  });

  it("returns true for HTTP 403", () => {
    expect(isCredentialError("HTTP 403: Forbidden")).toBe(true);
  });

  it("returns false for HTTP 500", () => {
    expect(isCredentialError("HTTP 500: Internal Server Error")).toBe(false);
  });

  it("returns false for network errors", () => {
    expect(isCredentialError("ECONNREFUSED")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isCredentialError("")).toBe(false);
  });

  it("returns true for 401 with Kinetica error body", () => {
    expect(
      isCredentialError('HTTP 401: {"status":"ERROR","message":"Insufficient credentials"}'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// credential re-prompt integration
// ---------------------------------------------------------------------------

describe("connectWithRetry — credential re-prompt", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockOfferSave.mockResolvedValue(undefined);
    mockResolveUrl.mockImplementation(async (url: string) => ({ ok: true, url }));
    exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number | string | null) => {
      throw new Error("process.exit called");
    });
    originalIsTTY = process.stdin.isTTY;
    // Default to interactive terminal
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  });

  it("offers re-prompt on 401 and succeeds with new credentials", async () => {
    // First session: 401, second session: success
    const failSession = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    });
    const goodSession = makeSession();

    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValueOnce(failSession).mockReturnValueOnce(goodSession);
    mockConfirm.mockResolvedValue(true);
    mockReprompt.mockResolvedValue({ user: "correct-user", pass: "correct-pass" });

    const result = await connectWithRetry();

    expect(result.session).toBe(goodSession);
    expect(mockConfirm).toHaveBeenCalledOnce();
    expect(mockReprompt).toHaveBeenCalledOnce();
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
  });

  it("creates new session with re-prompted credentials", async () => {
    const failSession = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    });
    const goodSession = makeSession();

    mockCollectCredentials.mockResolvedValue(
      makeCollectResult("http://host:9191", "bad-user", "bad-pass"),
    );
    mockCreateSession.mockReturnValueOnce(failSession).mockReturnValueOnce(goodSession);
    mockConfirm.mockResolvedValue(true);
    mockReprompt.mockResolvedValue({ user: "good-user", pass: "good-pass" });

    await connectWithRetry();

    // Second createSession call should use new credentials with same URL
    expect(mockCreateSession).toHaveBeenNthCalledWith(
      2,
      "http://host:9191",
      "good-user",
      "good-pass",
    );
  });

  it("exits immediately when user declines re-prompt on 401", async () => {
    const failSession = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    });

    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValue(failSession);
    mockConfirm.mockResolvedValue(false);

    await expect(connectWithRetry()).rejects.toThrow("process.exit called");

    expect(mockReprompt).not.toHaveBeenCalled();
    const errorCalls = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(errorCalls.some((m: string) => m.includes("Authentication failed"))).toBe(true);
  });

  it("exits immediately on 401 in non-interactive terminal", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    const failSession = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    });

    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValue(failSession);

    await expect(connectWithRetry()).rejects.toThrow("process.exit called");

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockReprompt).not.toHaveBeenCalled();
  });

  it("exits on 403 same as 401", async () => {
    const failSession = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 })),
    });

    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValue(failSession);
    mockConfirm.mockResolvedValue(false);

    await expect(connectWithRetry()).rejects.toThrow("process.exit called");
  });

  it("resets retry counter after successful re-prompt", async () => {
    // 401 → re-prompt → 500 → 500 → 500 → HM fallback
    const failAuth = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    });
    const failServer = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
    });

    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession
      .mockReturnValueOnce(failAuth) // 1st: 401
      .mockReturnValueOnce(failServer); // 2nd: 500 x3 → HM
    mockConfirm.mockResolvedValue(true);
    mockReprompt.mockResolvedValue({ user: "user2", pass: "pass2" });

    await expect(connectWithRetry()).rejects.toThrow("process.exit called");

    // Should have attempted 3 full retries with the new session (500 errors)
    const failServerMakeRequest = failServer.makeRequest as ReturnType<typeof vi.fn>;
    expect(failServerMakeRequest).toHaveBeenCalledTimes(3);
  });

  it("limits re-prompts to MAX_REPROMPTS (2)", async () => {
    // Use mockImplementation to create a fresh Response per call —
    // Response body can only be consumed once, so reusing the same object breaks.
    const failAuth = makeSession({
      makeRequest: vi
        .fn()
        .mockImplementation(() => Promise.resolve(new Response("Unauthorized", { status: 401 }))),
    });

    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValue(failAuth);
    mockConfirm.mockResolvedValue(true);
    mockReprompt.mockResolvedValue({ user: "still-wrong", pass: "still-wrong" });

    await expect(connectWithRetry()).rejects.toThrow("process.exit called");

    // Should have re-prompted exactly 2 times before giving up
    expect(mockReprompt).toHaveBeenCalledTimes(2);
  });

  it("offers to save with re-prompted username on success", async () => {
    const failSession = makeSession({
      makeRequest: vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    });
    const goodSession = makeSession();

    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValueOnce(failSession).mockReturnValueOnce(goodSession);
    mockConfirm.mockResolvedValue(true);
    mockReprompt.mockResolvedValue({ user: "new-admin", pass: "new-pass" });

    await connectWithRetry();

    // Should offer save with the new username (wasReprompted = true)
    expect(mockOfferSave).toHaveBeenCalledWith("http://kinetica:9191", "new-admin");
  });

  it("does not treat 500 as credential error — retries normally", async () => {
    const mockMakeRequest = vi
      .fn()
      .mockResolvedValueOnce(new Response("error", { status: 500 }))
      .mockResolvedValueOnce(new Response(makeStatusBody("7.2.3.11"), { status: 200 }));
    const session = makeSession({ makeRequest: mockMakeRequest });

    mockCollectCredentials.mockResolvedValue(makeCollectResult());
    mockCreateSession.mockReturnValue(session);

    const result = await connectWithRetry();

    expect(result.session).toBe(session);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockReprompt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// extractVersionFromHostManager
// ---------------------------------------------------------------------------

describe("extractVersionFromHostManager", () => {
  it("extracts version from valid host manager JSON response", () => {
    const body = JSON.stringify({ version: "7.2.3.11.20260322135954", hostname: "host1" });
    expect(extractVersionFromHostManager(body)).toBe("7.2.3.11.20260322135954");
  });

  it("returns undefined for malformed JSON", () => {
    expect(extractVersionFromHostManager("not json")).toBeUndefined();
  });

  it("returns undefined when version field is missing", () => {
    const body = JSON.stringify({ hostname: "host1", system_mode: "run" });
    expect(extractVersionFromHostManager(body)).toBeUndefined();
  });

  it("returns undefined when version is not a string", () => {
    const body = JSON.stringify({ version: 42 });
    expect(extractVersionFromHostManager(body)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// probeHostManager
// ---------------------------------------------------------------------------

describe("probeHostManager", () => {
  it("returns ok:true with version when HM responds with 200 and valid JSON", async () => {
    const hmResponse = JSON.stringify({ version: "7.2.3.11", hostname: "host1" });
    const session = makeSession({
      makeRequestToPort: vi.fn().mockResolvedValue(new Response(hmResponse, { status: 200 })),
    });

    const result = await probeHostManager(session);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.version).toBe("7.2.3.11");
  });

  it("returns ok:true with undefined version when HM responds but version field missing", async () => {
    const hmResponse = JSON.stringify({ hostname: "host1", system_mode: "run" });
    const session = makeSession({
      makeRequestToPort: vi.fn().mockResolvedValue(new Response(hmResponse, { status: 200 })),
    });

    const result = await probeHostManager(session);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.version).toBeUndefined();
  });

  it("returns ok:false when makeRequestToPort is not available", async () => {
    const session = makeSession(); // no makeRequestToPort
    const result = await probeHostManager(session);
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when HM returns non-200", async () => {
    const session = makeSession({
      makeRequestToPort: vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
    });

    const result = await probeHostManager(session);
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when network error occurs", async () => {
    const session = makeSession({
      makeRequestToPort: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });

    const result = await probeHostManager(session);
    expect(result.ok).toBe(false);
  });

  it("never throws", async () => {
    const session = makeSession({
      makeRequestToPort: vi.fn().mockRejectedValue(new Error("network failure")),
    });

    // Should not throw — returns ok:false
    await expect(probeHostManager(session)).resolves.toBeDefined();
  });

  it("calls makeRequestToPort with port 9300 and root endpoint", async () => {
    const mockPort = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const session = makeSession({ makeRequestToPort: mockPort });

    await probeHostManager(session);
    expect(mockPort).toHaveBeenCalledWith(9300, "/", undefined);
  });
});

describe("connectBestEffort", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KINETICA_URL;
    delete process.env.KINETICA_USER;
    delete process.env.KINETICA_PASS;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns undefined when credentials are not all in the environment", async () => {
    process.env.KINETICA_URL = "http://kinetica:9191";
    // user and pass missing
    expect(await connectBestEffort()).toBeUndefined();
    expect(mockResolveUrl).not.toHaveBeenCalled();
  });

  it("returns undefined (never throws) when the host is unreachable", async () => {
    process.env.KINETICA_URL = "kinetica:9191";
    process.env.KINETICA_USER = "admin";
    process.env.KINETICA_PASS = "secret";
    mockResolveUrl.mockResolvedValue({ ok: true, url: "http://kinetica:9191" });
    mockCreateSession.mockReturnValue({
      baseUrl: "http://kinetica:9191",
      makeRequest: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });

    expect(await connectBestEffort()).toBeUndefined();
  });

  it("attaches a live session when env creds resolve and the DB engine answers", async () => {
    process.env.KINETICA_URL = "kinetica:9191";
    process.env.KINETICA_USER = "admin";
    process.env.KINETICA_PASS = "secret";
    mockResolveUrl.mockResolvedValue({ ok: true, url: "http://kinetica:9191" });
    const body = JSON.stringify({
      data_str: JSON.stringify({ status_map: { system: JSON.stringify({ version: "7.2.3.17" }) } }),
    });
    mockCreateSession.mockReturnValue({
      baseUrl: "http://kinetica:9191",
      makeRequest: vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
    });

    const result = await connectBestEffort();
    expect(result).toBeDefined();
    expect(result?.degraded).toBe(false);
    expect(result?.kineticaVersion).toBe("7.2.3.17");
  });

  it("returns undefined when URL resolution fails", async () => {
    process.env.KINETICA_URL = "ftp://bad";
    process.env.KINETICA_USER = "admin";
    process.env.KINETICA_PASS = "secret";
    mockResolveUrl.mockResolvedValue({ ok: false, error: "unsupported scheme" });

    expect(await connectBestEffort()).toBeUndefined();
  });

  it("probes with a short timeout so a wedged DB engine can't freeze startup", async () => {
    process.env.KINETICA_URL = "kinetica:9191";
    process.env.KINETICA_USER = "admin";
    process.env.KINETICA_PASS = "secret";
    mockResolveUrl.mockResolvedValue({ ok: true, url: "http://kinetica:9191" });
    const body = JSON.stringify({
      data_str: JSON.stringify({ status_map: { system: JSON.stringify({ version: "7.2.3.17" }) } }),
    });
    mockCreateSession.mockReturnValue({
      baseUrl: "http://kinetica:9191",
      makeRequest: vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
    });

    await connectBestEffort();

    // The probe session is created with a bounded timeout (not the 30s default).
    expect(mockCreateSession).toHaveBeenCalledWith(
      "http://kinetica:9191",
      "admin",
      "secret",
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("resolves the URL non-interactively so it can never block on a prompt", async () => {
    // The whole point of best-effort is to stay silent. resolveUrl must be told
    // not to pop the HTTP-downgrade confirmation prompt, even in a TTY.
    process.env.KINETICA_URL = "kinetica:9191";
    process.env.KINETICA_USER = "admin";
    process.env.KINETICA_PASS = "secret";
    mockResolveUrl.mockResolvedValue({ ok: false, error: "HTTPS unavailable, non-interactive" });

    await connectBestEffort();

    expect(mockResolveUrl).toHaveBeenCalledWith("kinetica:9191", { nonInteractive: true });
  });
});
