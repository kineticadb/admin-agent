import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSession } from "./KineticaSession.js";

describe("createSession", () => {
  const TEST_URL = "http://localhost:9191";
  const TEST_USER = "admin";
  const TEST_PASS = "secret";

  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns object with baseUrl matching provided URL", () => {
    const session = createSession(TEST_URL, TEST_USER, TEST_PASS);
    expect(session.baseUrl).toBe(TEST_URL);
  });

  it("returns object with makeRequest function", () => {
    const session = createSession(TEST_URL, TEST_USER, TEST_PASS);
    expect(typeof session.makeRequest).toBe("function");
  });

  it("makeRequest calls fetch with correct URL (baseUrl + endpoint)", async () => {
    const session = createSession(TEST_URL, TEST_USER, TEST_PASS);
    await session.makeRequest("/api/endpoint");
    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe(`${TEST_URL}/api/endpoint`);
  });

  it("makeRequest sends correct Authorization header with Basic auth encoding", async () => {
    const session = createSession(TEST_URL, TEST_USER, TEST_PASS);
    await session.makeRequest("/api/endpoint");
    const [, options] = mockFetch.mock.calls[0];
    const expectedAuth = "Basic " + Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString("base64");
    expect(options.headers.Authorization).toBe(expectedAuth);
  });

  it("makeRequest sends Content-Type: application/json header", async () => {
    const session = createSession(TEST_URL, TEST_USER, TEST_PASS);
    await session.makeRequest("/api/endpoint");
    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  it("makeRequest serializes body as JSON", async () => {
    const session = createSession(TEST_URL, TEST_USER, TEST_PASS);
    const body = { table_name: "my_table", limit: 100 };
    await session.makeRequest("/api/endpoint", body);
    const [, options] = mockFetch.mock.calls[0];
    expect(options.body).toBe(JSON.stringify(body));
  });

  it("makeRequest uses POST method", async () => {
    const session = createSession(TEST_URL, TEST_USER, TEST_PASS);
    await session.makeRequest("/api/endpoint");
    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe("POST");
  });

  it("makeRequest defaults to no body when body parameter is omitted", async () => {
    const session = createSession(TEST_URL, TEST_USER, TEST_PASS);
    await session.makeRequest("/api/endpoint");
    const [, options] = mockFetch.mock.calls[0];
    expect(options.body).toBeUndefined();
  });

  describe("debug logging", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
      delete process.env.DEBUG;
    });

    it("logs method and full URL to stderr when DEBUG is set", async () => {
      process.env.DEBUG = "1";
      const session = createSession(TEST_URL, TEST_USER, TEST_PASS);
      await session.makeRequest("/show/system/properties");
      expect(errorSpy).toHaveBeenCalledWith(
        "[DEBUG] POST http://localhost:9191/show/system/properties",
      );
    });

    it("does not log when DEBUG is unset", async () => {
      delete process.env.DEBUG;
      const session = createSession(TEST_URL, TEST_USER, TEST_PASS);
      await session.makeRequest("/show/system/properties");
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("does not log when DEBUG is empty string", async () => {
      process.env.DEBUG = "";
      const session = createSession(TEST_URL, TEST_USER, TEST_PASS);
      await session.makeRequest("/show/system/properties");
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  it("makeRequest passes AbortSignal.timeout to fetch for request timeout", async () => {
    const session = createSession(TEST_URL, TEST_USER, TEST_PASS);
    await session.makeRequest("/api/endpoint");
    const [, options] = mockFetch.mock.calls[0];
    // Signal should be an AbortSignal (from AbortSignal.timeout)
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("credential isolation: returned session does NOT expose user, pass, password, auth, token, or credentials properties", () => {
    const session = createSession(TEST_URL, TEST_USER, TEST_PASS) as Record<string, unknown>;
    const forbiddenKeys = ["user", "pass", "password", "auth", "token", "credentials", "username"];
    for (const key of forbiddenKeys) {
      expect(session[key]).toBeUndefined();
    }
    // Only baseUrl, makeRequest, and makeRequestToPort should be accessible
    const sessionKeys = Object.keys(session);
    expect(sessionKeys).toEqual(
      expect.arrayContaining(["baseUrl", "makeRequest", "makeRequestToPort"]),
    );
    expect(sessionKeys.length).toBe(3);
  });
});
