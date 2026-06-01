import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printBanner } from "./banner.js";

describe("printBanner", () => {
  let stderrOutput: string[] = [];

  beforeEach(() => {
    stderrOutput = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrOutput.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a string containing admin-agent", () => {
    const result = printBanner();
    expect(result).toContain("admin-agent");
  });

  it("returns a string containing a version pattern (digits separated by dots)", () => {
    const result = printBanner();
    expect(result).toMatch(/\d+\.\d+\.\d+/);
  });

  it("does not throw", () => {
    expect(() => printBanner()).not.toThrow();
  });

  it("writes banner to stderr", () => {
    printBanner();
    expect(stderrOutput.join("")).toContain("admin-agent");
  });
});

// Mock authenticateAnthropic BEFORE importing main — vi.mock is hoisted
const { mockAuthenticateAnthropic } = vi.hoisted(() => ({
  mockAuthenticateAnthropic: vi.fn().mockResolvedValue({ method: "api_key" }),
}));
vi.mock("../auth/preflight.js", () => ({
  authenticateAnthropic: mockAuthenticateAnthropic,
}));

// Mock connectWithRetry BEFORE importing main — vi.mock is hoisted
vi.mock("../session/verify.js", () => ({
  connectWithRetry: vi.fn().mockResolvedValue({
    session: {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn(),
    },
    kineticaVersion: "7.2.3.11",
    degraded: false,
  }),
}));

// Mock runAgent BEFORE importing main — vi.mock is hoisted.
// SUPPORTED_MODELS and DEFAULT_AGENT_MODEL must be re-exported from the mock
// because the CLI imports them eagerly at module load (help text, --model
// validator, and banner model-resolution).
vi.mock("../agent/run-agent.js", () => ({
  runAgent: vi.fn().mockResolvedValue(undefined),
  SUPPORTED_MODELS: ["sonnet", "haiku", "opus"] as const,
  DEFAULT_AGENT_MODEL: "sonnet" as const,
}));

// Import main and the mocked modules after mocks are set up
import { main } from "./index.js";
import { connectWithRetry } from "../session/verify.js";
import { runAgent } from "../agent/run-agent.js";

describe("main", () => {
  let originalArgv: string[];
  let stdoutOutput: string[];
  let stderrOutput: string[];
  let mockExit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Store and reset argv to prevent --help/--version flags from affecting tests
    originalArgv = process.argv;
    process.argv = ["node", "admin-agent"];

    // Capture stdout/stderr
    stdoutOutput = [];
    stderrOutput = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdoutOutput.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrOutput.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });

    // Mock process.exit to prevent test runner from exiting
    mockExit = vi.fn();
    vi.spyOn(process, "exit").mockImplementation(
      mockExit as unknown as (code?: string | number | null) => never,
    );
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("calls connectWithRetry after banner when no flags are provided", async () => {
    await main();
    expect(connectWithRetry).toHaveBeenCalledOnce();
  });

  it("calls runAgent with session and version after successful connection", async () => {
    const fakeSession = {
      baseUrl: "http://localhost:9191",
      makeRequest: vi.fn(),
    };
    (connectWithRetry as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: fakeSession,
      kineticaVersion: "7.2.3.11",
      degraded: false,
    });
    await main();
    expect(runAgent).toHaveBeenCalledOnce();
    expect(runAgent).toHaveBeenCalledWith(fakeSession, "7.2.3.11", false, undefined);
  });

  // --model flag — valid value threads through to runAgent
  it("passes a valid --model value to runAgent as the 4th argument", async () => {
    process.argv = ["node", "admin-agent", "--model=haiku"];
    await main();
    expect(runAgent).toHaveBeenCalledOnce();
    const call = (runAgent as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(call[3]).toBe("haiku");
  });

  it("accepts --model=opus", async () => {
    process.argv = ["node", "admin-agent", "--model=opus"];
    await main();
    const call = (runAgent as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(call[3]).toBe("opus");
  });

  // --model flag — invalid value exits before connecting
  it("writes an error and returns early when --model value is unknown", async () => {
    process.argv = ["node", "admin-agent", "--model=bogus"];
    await main();
    const err = stderrOutput.join("");
    expect(err).toContain("unknown --model value");
    expect(err).toContain("bogus");
    expect(connectWithRetry).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  // Help text documents the --model flag
  it("help text documents the --model flag", async () => {
    process.argv = ["node", "admin-agent", "--help"];
    await main();
    const output = stdoutOutput.join("");
    expect(output).toContain("--model");
    expect(output).toContain("sonnet");
    expect(output).toContain("haiku");
    expect(output).toContain("opus");
  });

  // --version flag
  it("prints version and returns without connecting when --version is passed", async () => {
    process.argv = ["node", "admin-agent", "--version"];
    await main();
    const output = stdoutOutput.join("");
    expect(output).toMatch(/\d+\.\d+\.\d+/);
    expect(connectWithRetry).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  // --help flag
  it("prints help text and returns without connecting when --help is passed", async () => {
    process.argv = ["node", "admin-agent", "--help"];
    await main();
    const output = stdoutOutput.join("");
    expect(output).toContain("admin-agent");
    expect(output).toContain("--help");
    expect(output).toContain("--version");
    expect(output).toContain("--verbose");
    expect(connectWithRetry).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  // --verbose flag
  it("sets verbose to true when --verbose is passed", async () => {
    process.argv = ["node", "admin-agent", "--verbose"];
    await main();
    const { verbose: updatedVerbose } = await import("./index.js");
    expect(updatedVerbose).toBe(true);
  });

  // --login flag
  it("passes forceLogin: true to authenticateAnthropic when --login is provided", async () => {
    process.argv = ["node", "admin-agent", "--login"];
    await main();
    expect(mockAuthenticateAnthropic).toHaveBeenCalledOnce();
    const opts = mockAuthenticateAnthropic.mock.calls[0][0] as { forceLogin: boolean };
    expect(opts.forceLogin).toBe(true);
  });

  // --login-method flag
  it("parses --login-method=console and passes to authenticateAnthropic", async () => {
    process.argv = ["node", "admin-agent", "--login-method=console"];
    await main();
    const opts = mockAuthenticateAnthropic.mock.calls[0][0] as { loginMethod: string };
    expect(opts.loginMethod).toBe("console");
  });

  // --login-org flag
  it("parses --login-org=UUID and passes to authenticateAnthropic", async () => {
    process.argv = ["node", "admin-agent", "--login-org=org-abc-123"];
    await main();
    const opts = mockAuthenticateAnthropic.mock.calls[0][0] as { loginOrgUUID: string };
    expect(opts.loginOrgUUID).toBe("org-abc-123");
  });

  // Help text includes new flags
  it("help text documents --login flag", async () => {
    process.argv = ["node", "admin-agent", "--help"];
    await main();
    const output = stdoutOutput.join("");
    expect(output).toContain("--login");
    expect(output).toContain("ANTHROPIC_API_KEY");
  });

  // Preflight runs before Kinetica credential collection
  it("calls authenticateAnthropic before connectWithRetry", async () => {
    const callOrder: string[] = [];
    mockAuthenticateAnthropic.mockImplementation(async () => {
      callOrder.push("auth");
      return { method: "api_key" as const };
    });
    (connectWithRetry as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("connect");
      return {
        session: { baseUrl: "http://localhost:9191", makeRequest: vi.fn() },
        kineticaVersion: "7.2.3.11",
        degraded: false,
      };
    });

    await main();
    expect(callOrder).toEqual(["auth", "connect"]);
  });

  it("displays 'Authenticated via API key' when preflight returns api_key", async () => {
    mockAuthenticateAnthropic.mockResolvedValue({ method: "api_key" });
    await main();
    const output = stderrOutput.join("");
    expect(output).toContain("Authenticated via API key");
  });

  it("displays 'Authenticated via OAuth' when preflight returns oauth", async () => {
    mockAuthenticateAnthropic.mockResolvedValue({ method: "oauth" });
    await main();
    const output = stderrOutput.join("");
    expect(output).toContain("Authenticated via OAuth");
  });

  it("displays email when OAuth result includes it", async () => {
    mockAuthenticateAnthropic.mockResolvedValue({ method: "oauth", email: "user@test.com" });
    await main();
    const output = stderrOutput.join("");
    expect(output).toContain("Authenticated via OAuth (user@test.com)");
  });

  it("does not call connectWithRetry when authenticateAnthropic throws", async () => {
    mockAuthenticateAnthropic.mockRejectedValue(new Error("no auth"));
    await expect(main()).rejects.toThrow("no auth");
    expect(connectWithRetry).not.toHaveBeenCalled();
  });
});
