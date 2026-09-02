import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @inquirer/prompts before importing collect.ts
vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
}));

vi.mock("picocolors", () => ({
  default: {
    dim: (s: string) => `DIM(${s})`,
  },
}));

import { confirm, input, password } from "@inquirer/prompts";
import { collectCredentials, repromptCredentials } from "./collect.js";

const mockConfirm = confirm as unknown as ReturnType<typeof vi.fn>;
const mockInput = input as ReturnType<typeof vi.fn>;
const mockPassword = password as ReturnType<typeof vi.fn>;

describe("collectCredentials", () => {
  const ORIGINAL_ENV = { ...process.env };
  let originalIsTTY: boolean | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env vars to avoid test contamination
    delete process.env.KINETICA_URL;
    delete process.env.KINETICA_USER;
    delete process.env.KINETICA_PASS;
    delete process.env.KINETICA_STATS_HOST;
    // Default to non-interactive so existing tests don't trigger the confirmation
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore env
    process.env.KINETICA_URL = ORIGINAL_ENV.KINETICA_URL;
    process.env.KINETICA_USER = ORIGINAL_ENV.KINETICA_USER;
    process.env.KINETICA_PASS = ORIGINAL_ENV.KINETICA_PASS;
    // NOT `process.env.X = original` — assigning undefined stores the STRING "undefined",
    // which then leaks into the next test as a truthy value.
    if (ORIGINAL_ENV.KINETICA_STATS_HOST === undefined) delete process.env.KINETICA_STATS_HOST;
    else process.env.KINETICA_STATS_HOST = ORIGINAL_ENV.KINETICA_STATS_HOST;
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    consoleErrorSpy.mockRestore();
  });

  it("returns env vars when all three are set — no prompts called", async () => {
    process.env.KINETICA_URL = "http://kinetica:9191";
    process.env.KINETICA_USER = "admin";
    process.env.KINETICA_PASS = "secretpass";

    const result = await collectCredentials();

    expect(result.credentials).toEqual({
      url: "http://kinetica:9191",
      user: "admin",
      pass: "secretpass",
    });
    expect(result.prompted.size).toBe(0);
    expect(mockInput).not.toHaveBeenCalled();
    expect(mockPassword).not.toHaveBeenCalled();
  });

  it("prompts for URL when KINETICA_URL is not set", async () => {
    process.env.KINETICA_USER = "admin";
    process.env.KINETICA_PASS = "secretpass";
    mockInput.mockResolvedValue("http://prompted-url:9191");

    const result = await collectCredentials();

    expect(mockInput).toHaveBeenCalledOnce();
    expect(mockInput.mock.calls[0][0]).toMatchObject({ message: expect.stringContaining("URL") });
    expect(result.credentials.url).toBe("http://prompted-url:9191");
    expect(result.prompted.has("url")).toBe(true);
    expect(result.prompted.has("user")).toBe(false);
    expect(mockPassword).not.toHaveBeenCalled();
  });

  it("prompts for user when KINETICA_USER is not set", async () => {
    process.env.KINETICA_URL = "http://kinetica:9191";
    process.env.KINETICA_PASS = "secretpass";
    mockInput.mockResolvedValue("prompted-user");

    const result = await collectCredentials();

    expect(mockInput).toHaveBeenCalledOnce();
    expect(mockInput.mock.calls[0][0]).toMatchObject({
      message: expect.stringContaining("username"),
    });
    expect(result.credentials.user).toBe("prompted-user");
    expect(result.prompted.has("user")).toBe(true);
    expect(result.prompted.has("url")).toBe(false);
    expect(mockPassword).not.toHaveBeenCalled();
  });

  it("prompts for pass using password prompt with mask when KINETICA_PASS is not set", async () => {
    process.env.KINETICA_URL = "http://kinetica:9191";
    process.env.KINETICA_USER = "admin";
    mockPassword.mockResolvedValue("prompted-password");

    const result = await collectCredentials();

    expect(mockPassword).toHaveBeenCalledOnce();
    expect(mockPassword.mock.calls[0][0]).toMatchObject({
      message: expect.stringContaining("password"),
      mask: "*",
    });
    expect(result.credentials.pass).toBe("prompted-password");
    // Password is not tracked in prompted (we never save it)
    expect(result.prompted.size).toBe(0);
    expect(mockInput).not.toHaveBeenCalled();
  });

  it("prompts for all three when no env vars are set", async () => {
    mockInput
      .mockResolvedValueOnce("http://all-prompted:9191") // url
      .mockResolvedValueOnce("prompted-admin"); // user
    mockPassword.mockResolvedValue("prompted-secret");

    const result = await collectCredentials();

    expect(mockInput).toHaveBeenCalledTimes(2);
    expect(mockPassword).toHaveBeenCalledOnce();
    expect(result.credentials).toEqual({
      url: "http://all-prompted:9191",
      user: "prompted-admin",
      pass: "prompted-secret",
    });
    expect(result.prompted.has("url")).toBe(true);
    expect(result.prompted.has("user")).toBe(true);
  });

  it("returns object with readonly-compatible structure (CollectResult type)", async () => {
    process.env.KINETICA_URL = "http://kinetica:9191";
    process.env.KINETICA_USER = "admin";
    process.env.KINETICA_PASS = "pass";

    const result = await collectCredentials();

    expect(result).toHaveProperty("credentials");
    expect(result).toHaveProperty("prompted");
    expect(result.credentials).toHaveProperty("url");
    expect(result.credentials).toHaveProperty("user");
    expect(result.credentials).toHaveProperty("pass");
    expect(typeof result.credentials.url).toBe("string");
    expect(typeof result.credentials.user).toBe("string");
    expect(typeof result.credentials.pass).toBe("string");
    expect(result.prompted).toBeInstanceOf(Set);
  });
});

// ---------------------------------------------------------------------------
// saved connection confirmation
// ---------------------------------------------------------------------------

describe("collectCredentials — saved connection confirmation", () => {
  const ORIGINAL_ENV = { ...process.env };
  let originalIsTTY: boolean | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KINETICA_URL;
    delete process.env.KINETICA_USER;
    delete process.env.KINETICA_PASS;
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.KINETICA_URL = ORIGINAL_ENV.KINETICA_URL;
    process.env.KINETICA_USER = ORIGINAL_ENV.KINETICA_USER;
    process.env.KINETICA_PASS = ORIGINAL_ENV.KINETICA_PASS;
    // NOT `process.env.X = original` — assigning undefined stores the STRING "undefined",
    // which then leaks into the next test as a truthy value.
    if (ORIGINAL_ENV.KINETICA_STATS_HOST === undefined) delete process.env.KINETICA_STATS_HOST;
    else process.env.KINETICA_STATS_HOST = ORIGINAL_ENV.KINETICA_STATS_HOST;
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    consoleErrorSpy.mockRestore();
  });

  it("shows saved connection and asks to confirm when URL and user are in env", async () => {
    process.env.KINETICA_URL = "http://host1:9191";
    process.env.KINETICA_USER = "admin";
    process.env.KINETICA_PASS = "pass";
    mockConfirm.mockResolvedValue(true);

    await collectCredentials();

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("host1:9191"));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("admin"));
    expect(mockConfirm).toHaveBeenCalledOnce();
  });

  it("uses saved credentials when user confirms", async () => {
    process.env.KINETICA_URL = "http://host1:9191";
    process.env.KINETICA_USER = "admin";
    process.env.KINETICA_PASS = "secret";
    mockConfirm.mockResolvedValue(true);

    const result = await collectCredentials();

    expect(result.credentials).toMatchObject({
      url: "http://host1:9191",
      user: "admin",
      pass: "secret",
    });
    expect(result.prompted.size).toBe(0);
    // Confirming a saved connection asks NOTHING — including the stats host, which would
    // otherwise nag every launch of a cluster that has no stats stack.
    expect(mockInput).not.toHaveBeenCalled();
  });

  it("prompts for all fields when user declines saved connection", async () => {
    process.env.KINETICA_URL = "http://host1:9191";
    process.env.KINETICA_USER = "admin";
    process.env.KINETICA_PASS = "secret";
    mockConfirm.mockResolvedValue(false);
    mockInput
      .mockResolvedValueOnce("http://new-host:9191")
      .mockResolvedValueOnce("new-admin")
      .mockResolvedValueOnce("http://statshost");
    mockPassword.mockResolvedValue("new-pass");

    const result = await collectCredentials();

    expect(result.credentials).toEqual({
      url: "http://new-host:9191",
      user: "new-admin",
      pass: "new-pass",
      statsHost: "http://statshost",
    });
    expect(result.prompted.has("url")).toBe(true);
    expect(result.prompted.has("user")).toBe(true);
    expect(result.prompted.has("statsHost")).toBe(true);
  });

  it("shows an example URL on the endpoint prompt, in both branches that ask for it", async () => {
    // A bare hostname is also accepted (resolve-url probes the scheme), but showing a
    // full URL is the least ambiguous nudge for someone seeing this for the first time.
    mockInput
      .mockResolvedValueOnce("http://host1:9191")
      .mockResolvedValueOnce("admin")
      .mockResolvedValueOnce("");
    mockPassword.mockResolvedValue("pass");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    await collectCredentials();

    expect(String(mockInput.mock.calls[0][0].message)).toContain("http://dbhost:9191");
  });

  it("asks for the stats host after the password, and accepts a blank answer", async () => {
    mockInput
      .mockResolvedValueOnce("http://host1:9191")
      .mockResolvedValueOnce("admin")
      .mockResolvedValueOnce("   ");
    mockPassword.mockResolvedValue("pass");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const result = await collectCredentials();

    expect(result.credentials.statsHost).toBeUndefined();
    // Order matters: the stats question comes after the password, not before it.
    expect(mockInput).toHaveBeenCalledTimes(3);
    const label = String(mockInput.mock.calls[2][0].message);
    expect(label).toMatch(/prometheus|loki/i);
    // The example is the only thing signalling that no port belongs here — discover.ts
    // discards one silently — and it must stay port-less for that contrast to work
    // against the endpoint prompt's `http://dbhost:9191`.
    expect(label).toContain("http://statshost");
    expect(label).not.toMatch(/statshost:\d/);
    expect(label).toMatch(/blank/i);
  });

  it("takes KINETICA_STATS_HOST from env without asking", async () => {
    process.env.KINETICA_STATS_HOST = "http://statshost";
    mockInput.mockResolvedValueOnce("http://host1:9191").mockResolvedValueOnce("admin");
    mockPassword.mockResolvedValue("pass");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    const result = await collectCredentials();

    expect(result.credentials.statsHost).toBe("http://statshost");
    expect(result.prompted.has("statsHost")).toBe(false);
    expect(mockInput).toHaveBeenCalledTimes(2);
  });

  it("never asks in a non-interactive terminal", async () => {
    mockInput.mockResolvedValue("x");
    mockPassword.mockResolvedValue("pass");
    // This describe block sets isTTY true in its own setup; override it explicitly.
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const result = await collectCredentials();
    expect(result.credentials.statsHost).toBeUndefined();
    expect(result.prompted.has("statsHost")).toBe(false);
  });

  it("does not show confirmation when only URL is in env", async () => {
    process.env.KINETICA_URL = "http://host1:9191";
    mockInput.mockResolvedValue("prompted-user");
    mockPassword.mockResolvedValue("pass");

    await collectCredentials();

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("does not show confirmation when only user is in env", async () => {
    process.env.KINETICA_USER = "admin";
    mockInput.mockResolvedValue("http://prompted:9191");
    mockPassword.mockResolvedValue("pass");

    await collectCredentials();

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("skips confirmation in non-interactive terminal", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    process.env.KINETICA_URL = "http://host1:9191";
    process.env.KINETICA_USER = "admin";
    process.env.KINETICA_PASS = "pass";

    const result = await collectCredentials();

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(result.credentials.url).toBe("http://host1:9191");
  });

  it("still prompts for password when user confirms saved connection but no KINETICA_PASS", async () => {
    process.env.KINETICA_URL = "http://host1:9191";
    process.env.KINETICA_USER = "admin";
    mockConfirm.mockResolvedValue(true);
    mockPassword.mockResolvedValue("prompted-pass");

    const result = await collectCredentials();

    expect(result.credentials.pass).toBe("prompted-pass");
    expect(mockPassword).toHaveBeenCalledOnce();
    expect(mockInput).not.toHaveBeenCalled();
  });
});

describe("repromptCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("always prompts for user and password (ignores env vars)", async () => {
    process.env.KINETICA_USER = "env-admin";
    process.env.KINETICA_PASS = "env-pass";
    mockInput.mockResolvedValue("new-user");
    mockPassword.mockResolvedValue("new-pass");

    const result = await repromptCredentials();

    expect(mockInput).toHaveBeenCalledOnce();
    expect(mockPassword).toHaveBeenCalledOnce();
    expect(result).toEqual({ user: "new-user", pass: "new-pass" });
  });

  it("prompts for username with expected message", async () => {
    mockInput.mockResolvedValue("admin");
    mockPassword.mockResolvedValue("secret");

    await repromptCredentials();

    expect(mockInput.mock.calls[0][0]).toMatchObject({
      message: expect.stringContaining("username"),
    });
  });

  it("prompts for password with mask", async () => {
    mockInput.mockResolvedValue("admin");
    mockPassword.mockResolvedValue("secret");

    await repromptCredentials();

    expect(mockPassword.mock.calls[0][0]).toMatchObject({
      message: expect.stringContaining("password"),
      mask: "*",
    });
  });

  it("returns readonly-compatible object", async () => {
    mockInput.mockResolvedValue("user");
    mockPassword.mockResolvedValue("pass");

    const result = await repromptCredentials();

    expect(typeof result.user).toBe("string");
    expect(typeof result.pass).toBe("string");
  });
});
