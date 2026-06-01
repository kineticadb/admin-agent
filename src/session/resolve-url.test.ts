import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted before any imports
// ---------------------------------------------------------------------------

const { mockConfirm } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
}));

vi.mock("@inquirer/prompts", () => ({
  confirm: mockConfirm,
}));

import { hasProtocol, resolveUrl } from "./resolve-url.js";

// ---------------------------------------------------------------------------
// hasProtocol (pure — no mocks needed)
// ---------------------------------------------------------------------------

describe("hasProtocol", () => {
  it("returns true for http://", () => {
    expect(hasProtocol("http://host1:9191")).toBe(true);
  });

  it("returns true for https://", () => {
    expect(hasProtocol("https://host1:9191")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(hasProtocol("HTTP://host1:9191")).toBe(true);
    expect(hasProtocol("HTTPS://host1:9191")).toBe(true);
    expect(hasProtocol("Http://host1:9191")).toBe(true);
  });

  it("returns false for bare hostname:port", () => {
    expect(hasProtocol("host1:9191")).toBe(false);
  });

  it("returns false for IP:port", () => {
    expect(hasProtocol("10.0.0.1:9191")).toBe(false);
  });

  it("returns false for IPv6", () => {
    expect(hasProtocol("[::1]:9191")).toBe(false);
  });

  it("returns false for other protocols", () => {
    expect(hasProtocol("ftp://host1:9191")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasProtocol("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveUrl
// ---------------------------------------------------------------------------

describe("resolveUrl", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalTTY: boolean | undefined;
  let originalHttpsOnly: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalTTY = process.stdin.isTTY;
    originalHttpsOnly = process.env.KINETICA_HTTPS_ONLY;
    vi.clearAllMocks();
    // Default: non-TTY and HTTPS_ONLY unset — tests that need them override per-test
    Object.defineProperty(process.stdin, "isTTY", { value: false, writable: true });
    delete process.env.KINETICA_HTTPS_ONLY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process.stdin, "isTTY", { value: originalTTY, writable: true });
    if (originalHttpsOnly !== undefined) {
      process.env.KINETICA_HTTPS_ONLY = originalHttpsOnly;
    } else {
      delete process.env.KINETICA_HTTPS_ONLY;
    }
  });

  // ---- Input already has protocol ----------------------------------------

  describe("input already has protocol", () => {
    it("returns url as-is for http://", async () => {
      const result = await resolveUrl("http://host1:9191");
      expect(result).toEqual({ ok: true, url: "http://host1:9191" });
    });

    it("returns url as-is for https://", async () => {
      const result = await resolveUrl("https://host1:9191");
      expect(result).toEqual({ ok: true, url: "https://host1:9191" });
    });

    it("strips trailing slash", async () => {
      const result = await resolveUrl("http://host1:9191/");
      expect(result).toEqual({ ok: true, url: "http://host1:9191" });
    });

    it("strips multiple trailing slashes", async () => {
      const result = await resolveUrl("http://host1:9191///");
      expect(result).toEqual({ ok: true, url: "http://host1:9191" });
    });

    it("trims whitespace", async () => {
      const result = await resolveUrl("  http://host1:9191  ");
      expect(result).toEqual({ ok: true, url: "http://host1:9191" });
    });

    it("handles uppercase protocol", async () => {
      const result = await resolveUrl("HTTP://host1:9191");
      expect(result).toEqual({ ok: true, url: "HTTP://host1:9191" });
    });

    it("explicit http:// never triggers confirm prompt", async () => {
      // Even under TTY, an explicit http:// prefix is a conscious choice
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
      await resolveUrl("http://host1:9191");
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    it("explicit http:// is allowed even when KINETICA_HTTPS_ONLY=1", async () => {
      // The env var gates the auto-fallback path, not explicit opt-in
      process.env.KINETICA_HTTPS_ONLY = "1";
      const result = await resolveUrl("http://host1:9191");
      expect(result).toEqual({ ok: true, url: "http://host1:9191" });
    });
  });

  // ---- Empty / invalid input ---------------------------------------------

  describe("empty and invalid input", () => {
    it("returns ok:false for empty string", async () => {
      const result = await resolveUrl("");
      expect(result.ok).toBe(false);
    });

    it("returns ok:false for whitespace-only", async () => {
      const result = await resolveUrl("   ");
      expect(result.ok).toBe(false);
    });

    it("returns ok:false for unsupported protocol", async () => {
      const result = await resolveUrl("ftp://host1:9191");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("ftp");
      }
    });
  });

  // ---- Protocol detection (HTTPS succeeds) --------------------------------

  describe("no protocol — HTTPS succeeds", () => {
    it("returns https:// URL when HTTPS probe succeeds", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));

      const result = await resolveUrl("host1:9191");

      expect(result).toEqual({ ok: true, url: "https://host1:9191" });
    });

    it("treats 401 as successful probe", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));

      const result = await resolveUrl("host1:9191");

      expect(result).toEqual({ ok: true, url: "https://host1:9191" });
    });

    it("treats 500 as successful probe", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("Error", { status: 500 }));

      const result = await resolveUrl("host1:9191");

      expect(result).toEqual({ ok: true, url: "https://host1:9191" });
    });

    it("does not try HTTP when HTTPS succeeds", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
      globalThis.fetch = mockFetch;

      await resolveUrl("host1:9191");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain("https://");
    });

    it("does not prompt when HTTPS succeeds", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });

      await resolveUrl("host1:9191");

      expect(mockConfirm).not.toHaveBeenCalled();
    });
  });

  // ---- HTTPS fails, HTTP succeeds: TTY + confirm ------------------------

  describe("no protocol — HTTPS fails, HTTP succeeds (TTY, confirm accepted)", () => {
    beforeEach(() => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
      mockConfirm.mockResolvedValue(true);
    });

    it("falls back to http:// when user confirms", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce(new Response("", { status: 200 }));
      globalThis.fetch = mockFetch;

      const result = await resolveUrl("host1:9191");

      expect(result).toEqual({ ok: true, url: "http://host1:9191" });
      expect(mockConfirm).toHaveBeenCalledOnce();
    });

    it("falls back to http:// on HTTPS timeout", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"))
        .mockResolvedValueOnce(new Response("", { status: 200 }));
      globalThis.fetch = mockFetch;

      const result = await resolveUrl("host1:9191");

      expect(result).toEqual({ ok: true, url: "http://host1:9191" });
    });

    it("makes two fetch calls — HTTPS first, HTTP second", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce(new Response("", { status: 200 }));
      globalThis.fetch = mockFetch;

      await resolveUrl("host1:9191");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toBe("https://host1:9191");
      expect(mockFetch.mock.calls[1][0]).toBe("http://host1:9191");
    });

    it("warning is written to stderr before prompt", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      globalThis.fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce(new Response("", { status: 200 }));

      await resolveUrl("host1:9191");

      const writes = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(writes).toMatch(/WARNING/i);
      expect(writes).toMatch(/plaintext|cleartext|clear/i);

      stderrSpy.mockRestore();
    });
  });

  // ---- HTTPS fails, HTTP succeeds: TTY + decline --------------------------

  describe("no protocol — HTTPS fails, HTTP succeeds (TTY, user declines)", () => {
    beforeEach(() => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
      mockConfirm.mockResolvedValue(false);
    });

    it("returns ok:false when user declines fallback", async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce(new Response("", { status: 200 }));

      const result = await resolveUrl("host1:9191");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/declined/i);
      }
    });

    it("returns ok:false when confirm prompt is interrupted (throws)", async () => {
      mockConfirm.mockRejectedValueOnce(new Error("User interrupt"));
      globalThis.fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce(new Response("", { status: 200 }));

      const result = await resolveUrl("host1:9191");

      expect(result.ok).toBe(false);
    });
  });

  // ---- HTTPS fails, HTTP succeeds: non-interactive ----------------------

  describe("no protocol — HTTPS fails, HTTP succeeds (non-interactive)", () => {
    it("refuses fallback without prompting when non-TTY", async () => {
      // isTTY is false by default in beforeEach
      globalThis.fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce(new Response("", { status: 200 }));

      const result = await resolveUrl("host1:9191");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/non-interactive|http:\/\//i);
      }
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    it("error message suggests explicit http:// prefix", async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce(new Response("", { status: 200 }));

      const result = await resolveUrl("host1:9191");

      if (!result.ok) {
        expect(result.error).toContain("http://");
      }
    });
  });

  // ---- KINETICA_HTTPS_ONLY=1 --------------------------------------------

  describe("KINETICA_HTTPS_ONLY=1 strict mode", () => {
    beforeEach(() => {
      process.env.KINETICA_HTTPS_ONLY = "1";
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    });

    it("refuses fallback without probing HTTP when HTTPS fails", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      globalThis.fetch = mockFetch;

      const result = await resolveUrl("host1:9191");

      expect(result.ok).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain("https://");
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    it("error mentions KINETICA_HTTPS_ONLY", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await resolveUrl("host1:9191");

      if (!result.ok) {
        expect(result.error).toContain("KINETICA_HTTPS_ONLY");
      }
    });

    it("HTTPS success is unaffected by the env var", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));

      const result = await resolveUrl("host1:9191");

      expect(result).toEqual({ ok: true, url: "https://host1:9191" });
    });
  });

  // ---- Both protocols fail ------------------------------------------------

  describe("no protocol — both fail", () => {
    beforeEach(() => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    });

    it("returns ok:false when both protocols fail", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockRejectedValueOnce(new Error("ECONNREFUSED"));
      globalThis.fetch = mockFetch;

      const result = await resolveUrl("host1:9191");

      expect(result.ok).toBe(false);
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    it("error message mentions both protocols", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockRejectedValueOnce(new Error("ECONNREFUSED"));
      globalThis.fetch = mockFetch;

      const result = await resolveUrl("host1:9191");

      if (!result.ok) {
        expect(result.error).toContain("https");
        expect(result.error).toContain("http");
      }
    });
  });

  // ---- Probe behavior -----------------------------------------------------

  describe("probe behavior", () => {
    it("uses HEAD method", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
      globalThis.fetch = mockFetch;

      await resolveUrl("host1:9191");

      const options = mockFetch.mock.calls[0][1] as RequestInit;
      expect(options.method).toBe("HEAD");
    });

    it("sets a timeout signal", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
      globalThis.fetch = mockFetch;

      await resolveUrl("host1:9191");

      const options = mockFetch.mock.calls[0][1] as RequestInit;
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });
  });

  // ---- Edge cases ---------------------------------------------------------

  describe("edge cases", () => {
    it("handles IP address without protocol", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));

      const result = await resolveUrl("10.0.0.1:9191");

      expect(result).toEqual({ ok: true, url: "https://10.0.0.1:9191" });
    });

    it("handles hostname without port", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));

      const result = await resolveUrl("host1");

      expect(result).toEqual({ ok: true, url: "https://host1" });
    });

    it("handles IPv6 address", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));

      const result = await resolveUrl("[::1]:9191");

      expect(result).toEqual({ ok: true, url: "https://[::1]:9191" });
    });

    it("strips trailing slash from bare hostname", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));

      const result = await resolveUrl("host1:9191/");

      expect(result).toEqual({ ok: true, url: "https://host1:9191" });
    });

    it("never throws", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("catastrophic"));

      await expect(resolveUrl("host1:9191")).resolves.toBeDefined();
    });
  });
});
