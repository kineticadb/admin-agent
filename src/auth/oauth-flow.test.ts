import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock open-browser before importing oauth-flow
const { mockOpenBrowser } = vi.hoisted(() => ({
  mockOpenBrowser: vi.fn().mockReturnValue(true),
}));
vi.mock("./open-browser.js", () => ({
  openBrowser: mockOpenBrowser,
}));

import { resolveAuthentication } from "./oauth-flow.js";
import type { OAuthCapableQuery } from "./oauth-flow.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockQuery(overrides?: Partial<OAuthCapableQuery>): OAuthCapableQuery {
  return {
    claudeAuthenticate: vi.fn().mockResolvedValue({
      manualUrl: "https://manual.example.com/auth",
      automaticUrl: "https://auto.example.com/auth",
    }),
    claudeOAuthWaitForCompletion: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveAuthentication", () => {
  let stderrOutput: string[];

  beforeEach(() => {
    stderrOutput = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrOutput.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    mockOpenBrowser.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- API key path (no OAuth) ---

  it("returns api_key method when API key is present and forceLogin is false", async () => {
    const query = makeMockQuery();
    const result = await resolveAuthentication(query, {
      forceLogin: false,
      loginWithClaudeAi: true,
      hasApiKey: true,
    });

    expect(result).toEqual({ method: "api_key" });
    expect(query.claudeAuthenticate).not.toHaveBeenCalled();
  });

  // --- OAuth path ---

  it("triggers OAuth when no API key is present", async () => {
    const query = makeMockQuery();
    const result = await resolveAuthentication(query, {
      forceLogin: false,
      loginWithClaudeAi: true,
      hasApiKey: false,
    });

    expect(result.method).toBe("oauth");
    expect(query.claudeAuthenticate).toHaveBeenCalledWith(true);
    expect(query.claudeOAuthWaitForCompletion).toHaveBeenCalledOnce();
  });

  it("triggers OAuth when forceLogin is true even with API key", async () => {
    const query = makeMockQuery();
    const result = await resolveAuthentication(query, {
      forceLogin: true,
      loginWithClaudeAi: true,
      hasApiKey: true,
    });

    expect(result.method).toBe("oauth");
    expect(query.claudeAuthenticate).toHaveBeenCalledOnce();
  });

  it("passes loginWithClaudeAi=false for console login", async () => {
    const query = makeMockQuery();
    await resolveAuthentication(query, {
      forceLogin: true,
      loginWithClaudeAi: false,
      hasApiKey: true,
    });

    expect(query.claudeAuthenticate).toHaveBeenCalledWith(false);
  });

  // --- Browser opening ---

  it("opens browser with automaticUrl on success", async () => {
    const query = makeMockQuery();
    await resolveAuthentication(query, {
      forceLogin: false,
      loginWithClaudeAi: true,
      hasApiKey: false,
    });

    expect(mockOpenBrowser).toHaveBeenCalledWith("https://auto.example.com/auth");
  });

  it("prints manualUrl to stderr when browser open fails", async () => {
    mockOpenBrowser.mockReturnValue(false);
    const query = makeMockQuery();
    await resolveAuthentication(query, {
      forceLogin: false,
      loginWithClaudeAi: true,
      hasApiKey: false,
    });

    const output = stderrOutput.join("");
    expect(output).toContain("https://manual.example.com/auth");
  });

  it("prints waiting message during OAuth flow", async () => {
    const query = makeMockQuery();
    await resolveAuthentication(query, {
      forceLogin: false,
      loginWithClaudeAi: true,
      hasApiKey: false,
    });

    const output = stderrOutput.join("");
    expect(output).toMatch(/waiting|browser/i);
  });

  // --- Error handling (graceful degradation) ---

  it("returns oauth result with warning when claudeAuthenticate throws", async () => {
    const query = makeMockQuery({
      claudeAuthenticate: vi.fn().mockRejectedValue(new Error("SDK error")),
    });
    const result = await resolveAuthentication(query, {
      forceLogin: false,
      loginWithClaudeAi: true,
      hasApiKey: false,
    });

    expect(result.method).toBe("oauth");
    const output = stderrOutput.join("");
    expect(output).toMatch(/warning|failed|error/i);
  });

  it("returns oauth result with warning when claudeOAuthWaitForCompletion throws", async () => {
    const query = makeMockQuery({
      claudeOAuthWaitForCompletion: vi.fn().mockRejectedValue(new Error("timeout")),
    });
    const result = await resolveAuthentication(query, {
      forceLogin: false,
      loginWithClaudeAi: true,
      hasApiKey: false,
    });

    expect(result.method).toBe("oauth");
    const output = stderrOutput.join("");
    expect(output).toMatch(/warning|failed|error/i);
  });
});
