import { describe, it, expect, vi, afterEach } from "vitest";
import { execFile } from "child_process";
import { logout } from "./logout.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:module", () => ({
  createRequire: () => ({
    resolve: () => "/mocked/sdk/sdk.mjs",
  }),
}));

vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...actual,
    default: { ...actual, dirname: () => "/mocked/sdk", join: actual.join },
  };
});

// createRequire receives __filename (available in both CJS and tsx).

const mockExecFile = vi.mocked(execFile);

/**
 * Helper to make mockExecFile behave like the promisified version.
 * The real `promisify(execFile)` returns a promise; our mock needs to
 * invoke the callback that `promisify` wraps around.
 */
function mockSuccess(stdout: string, stderr = ""): void {
  mockExecFile.mockImplementation(((
    _cmd: unknown,
    _args: unknown,
    cb: (err: null, result: { stdout: string; stderr: string }) => void,
  ) => {
    cb(null, { stdout, stderr });
  }) as typeof execFile);
}

function mockFailure(error: Error): void {
  mockExecFile.mockImplementation(((_cmd: unknown, _args: unknown, cb: (err: Error) => void) => {
    cb(error);
  }) as typeof execFile);
}

describe("logout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls claude auth logout", async () => {
    mockSuccess("Logged out.");
    await logout();

    expect(mockExecFile).toHaveBeenCalledWith(
      process.execPath,
      ["/mocked/sdk/cli.js", "auth", "logout"],
      expect.any(Function),
    );
  });

  it("returns success with stdout message", async () => {
    mockSuccess("Successfully logged out.\n");

    const result = await logout();

    expect(result).toEqual({ success: true, message: "Successfully logged out." });
  });

  it("returns success with stderr message when stdout is empty", async () => {
    mockSuccess("", "Logged out via stderr.\n");

    const result = await logout();

    expect(result).toEqual({ success: true, message: "Logged out via stderr." });
  });

  it("returns default message when both stdout and stderr are empty", async () => {
    mockSuccess("");

    const result = await logout();

    expect(result).toEqual({ success: true, message: "Logged out successfully." });
  });

  it("returns failure when execFile throws", async () => {
    mockFailure(new Error("command not found: claude"));

    const result = await logout();

    expect(result).toEqual({
      success: false,
      message: "Logout failed: command not found: claude",
    });
  });

  it("returns failure with stringified error for non-Error throws", async () => {
    mockExecFile.mockImplementation(((_cmd: unknown, _args: unknown, cb: (err: string) => void) => {
      cb("unexpected string error");
    }) as unknown as typeof execFile);

    const result = await logout();

    expect(result).toEqual({
      success: false,
      message: "Logout failed: unexpected string error",
    });
  });
});
