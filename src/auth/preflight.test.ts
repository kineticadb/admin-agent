import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted before any imports
// ---------------------------------------------------------------------------

const { mockQuery, mockResolveAuth, mockAccountInfo } = vi.hoisted(() => {
  const mockAccountInfoFn = vi.fn();
  const mockQueryObj = {
    return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
    accountInfo: mockAccountInfoFn,
  };
  return {
    mockQuery: vi.fn().mockReturnValue(mockQueryObj),
    mockResolveAuth: vi.fn().mockResolvedValue({ method: "oauth" as const }),
    mockAccountInfo: mockAccountInfoFn,
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: mockQuery,
}));

vi.mock("./oauth-flow.js", () => ({
  resolveAuthentication: mockResolveAuth,
}));

import { authenticateAnthropic } from "./preflight.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("authenticateAnthropic", () => {
  let originalApiKey: string | undefined;
  let originalTTY: boolean | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: probe fails so existing OAuth-path tests still fall through
    mockAccountInfo.mockRejectedValue(new Error("no cached credentials"));
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    originalTTY = process.stdin.isTTY;
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    Object.defineProperty(process.stdin, "isTTY", { value: originalTTY, writable: true });
    vi.restoreAllMocks();
  });

  // --- API key fast path ---

  it("returns api_key immediately when API key is present and forceLogin is false", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const result = await authenticateAnthropic({ forceLogin: false });

    expect(result).toEqual({ method: "api_key" });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockResolveAuth).not.toHaveBeenCalled();
  });

  it("does not create a query when API key is present", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    await authenticateAnthropic({ forceLogin: false });

    expect(mockQuery).not.toHaveBeenCalled();
  });

  // --- Non-interactive error ---

  it("throws when no API key and terminal is non-interactive", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, writable: true });

    await expect(authenticateAnthropic({ forceLogin: false })).rejects.toThrow(/non-interactive/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("throws when forceLogin is true but terminal is non-interactive", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    Object.defineProperty(process.stdin, "isTTY", { value: false, writable: true });

    await expect(authenticateAnthropic({ forceLogin: true })).rejects.toThrow(/non-interactive/);
  });

  it("includes helpful error message for non-interactive terminals", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, writable: true });

    await expect(authenticateAnthropic({ forceLogin: false })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  // --- OAuth path ---

  it("creates an auth-only query when no API key is set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

    await authenticateAnthropic({ forceLogin: false });

    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockResolveAuth).toHaveBeenCalledOnce();
  });

  it("creates an auth-only query when forceLogin is true despite API key", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

    await authenticateAnthropic({ forceLogin: true });

    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockResolveAuth).toHaveBeenCalledOnce();
  });

  it("passes loginWithClaudeAi=true for claudeai login method", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

    await authenticateAnthropic({ forceLogin: false, loginMethod: "claudeai" });

    const resolveArgs = mockResolveAuth.mock.calls[0][1] as { loginWithClaudeAi: boolean };
    expect(resolveArgs.loginWithClaudeAi).toBe(true);
  });

  it("passes loginWithClaudeAi=false for console login method", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

    await authenticateAnthropic({ forceLogin: false, loginMethod: "console" });

    const resolveArgs = mockResolveAuth.mock.calls[0][1] as { loginWithClaudeAi: boolean };
    expect(resolveArgs.loginWithClaudeAi).toBe(false);
  });

  it("defaults loginWithClaudeAi to true when no login method specified", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

    await authenticateAnthropic({ forceLogin: false });

    const resolveArgs = mockResolveAuth.mock.calls[0][1] as { loginWithClaudeAi: boolean };
    expect(resolveArgs.loginWithClaudeAi).toBe(true);
  });

  // --- Query options ---

  it("strips API key from env when forceLogin is true", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

    await authenticateAnthropic({ forceLogin: true });

    const queryOpts = mockQuery.mock.calls[0][0] as {
      options: { env: Record<string, string | undefined> };
    };
    expect(queryOpts.options.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("sets persistSession to false on auth query", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

    await authenticateAnthropic({ forceLogin: false });

    const queryOpts = mockQuery.mock.calls[0][0] as {
      options: { persistSession: boolean };
    };
    expect(queryOpts.options.persistSession).toBe(false);
  });

  it("passes forceLoginMethod when loginMethod is provided", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

    await authenticateAnthropic({ forceLogin: false, loginMethod: "console" });

    const queryOpts = mockQuery.mock.calls[0][0] as {
      options: { forceLoginMethod?: string };
    };
    expect(queryOpts.options.forceLoginMethod).toBe("console");
  });

  it("passes forceLoginOrgUUID when loginOrgUUID is provided", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

    await authenticateAnthropic({ forceLogin: false, loginOrgUUID: "org-123" });

    const queryOpts = mockQuery.mock.calls[0][0] as {
      options: { forceLoginOrgUUID?: string };
    };
    expect(queryOpts.options.forceLoginOrgUUID).toBe("org-123");
  });

  it("sets CLAUDE_AGENT_SDK_CLIENT_APP in env", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

    await authenticateAnthropic({ forceLogin: false });

    const queryOpts = mockQuery.mock.calls[0][0] as {
      options: { env: Record<string, string> };
    };
    expect(queryOpts.options.env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("admin-agent");
  });

  // --- Cleanup ---

  it("aborts and closes the auth query after successful OAuth", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

    await authenticateAnthropic({ forceLogin: false });

    const queryObj = mockQuery.mock.results[0].value as { return: ReturnType<typeof vi.fn> };
    expect(queryObj.return).toHaveBeenCalledOnce();
  });

  it("aborts and closes the auth query even when OAuth fails", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    mockResolveAuth.mockRejectedValueOnce(new Error("OAuth failed"));

    await expect(authenticateAnthropic({ forceLogin: false })).rejects.toThrow("OAuth failed");

    const queryObj = mockQuery.mock.results[0].value as { return: ReturnType<typeof vi.fn> };
    expect(queryObj.return).toHaveBeenCalledOnce();
  });

  it("returns the AuthResult from resolveAuthentication", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    mockResolveAuth.mockResolvedValueOnce({ method: "oauth", email: "user@example.com" });

    const result = await authenticateAnthropic({ forceLogin: false });

    expect(result).toEqual({ method: "oauth", email: "user@example.com" });
  });

  // --- Cached credential probe ---

  describe("cached credential probe", () => {
    it("skips OAuth when accountInfo returns cached credentials with email", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
      mockAccountInfo.mockResolvedValueOnce({ email: "cached@example.com", apiKeySource: "oauth" });

      const result = await authenticateAnthropic({ forceLogin: false });

      expect(result).toEqual({ method: "oauth", email: "cached@example.com" });
      expect(mockResolveAuth).not.toHaveBeenCalled();
    });

    it("skips OAuth when accountInfo has apiKeySource but no email", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
      mockAccountInfo.mockResolvedValueOnce({ apiKeySource: "oauth" });

      const result = await authenticateAnthropic({ forceLogin: false });

      expect(result).toEqual({ method: "oauth", email: undefined });
      expect(mockResolveAuth).not.toHaveBeenCalled();
    });

    it("falls through to OAuth when accountInfo throws", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
      mockAccountInfo.mockRejectedValueOnce(new Error("subprocess not ready"));

      const result = await authenticateAnthropic({ forceLogin: false });

      expect(mockResolveAuth).toHaveBeenCalledOnce();
      expect(result.method).toBe("oauth");
    });

    it("falls through to OAuth when accountInfo returns empty info", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
      mockAccountInfo.mockResolvedValueOnce({});

      const result = await authenticateAnthropic({ forceLogin: false });

      expect(mockResolveAuth).toHaveBeenCalledOnce();
      expect(result.method).toBe("oauth");
    });

    it("falls through to OAuth when accountInfo times out", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
      mockAccountInfo.mockReturnValueOnce(new Promise(() => {}));

      const result = await authenticateAnthropic({ forceLogin: false });

      expect(mockResolveAuth).toHaveBeenCalledOnce();
      expect(result.method).toBe("oauth");
    }, 15_000);

    it("skips probe entirely when forceLogin is true", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
      mockAccountInfo.mockResolvedValueOnce({ email: "cached@example.com" });

      await authenticateAnthropic({ forceLogin: true });

      expect(mockAccountInfo).not.toHaveBeenCalled();
      expect(mockResolveAuth).toHaveBeenCalledOnce();
    });

    it("aborts and closes auth query even when probe succeeds", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
      mockAccountInfo.mockResolvedValueOnce({ email: "cached@example.com" });

      await authenticateAnthropic({ forceLogin: false });

      const queryObj = mockQuery.mock.results[0].value as { return: ReturnType<typeof vi.fn> };
      expect(queryObj.return).toHaveBeenCalledOnce();
    });
  });
});
