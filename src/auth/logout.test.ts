import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "child_process";
import { logout, binaryCandidates } from "./logout.js";

const SDK = "@anthropic-ai/claude-agent-sdk";

// Hoisted so the vi.mock factory below can read it without a TDZ error —
// the factory runs while ./logout.js is imported, before module-level lets init.
const h = vi.hoisted(() => ({ resolvable: new Set<string>() }));

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:module", () => ({
  createRequire: () => ({
    resolve: (spec: string): string => {
      if (!h.resolvable.has(spec)) {
        throw Object.assign(new Error(`Cannot find module '${spec}'`), {
          code: "MODULE_NOT_FOUND",
        });
      }
      return `/mocked/node_modules/${spec}`;
    },
  }),
}));

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

describe("binaryCandidates", () => {
  it("names the single platform package on darwin", () => {
    expect(binaryCandidates("darwin", "arm64", false)).toEqual([`${SDK}-darwin-arm64/claude`]);
  });

  it("appends .exe on win32", () => {
    expect(binaryCandidates("win32", "x64", false)).toEqual([`${SDK}-win32-x64/claude.exe`]);
  });

  it("tries glibc before musl on a glibc linux host", () => {
    expect(binaryCandidates("linux", "x64", false)).toEqual([
      `${SDK}-linux-x64/claude`,
      `${SDK}-linux-x64-musl/claude`,
    ]);
  });

  it("tries musl first on a musl linux host", () => {
    expect(binaryCandidates("linux", "arm64", true)).toEqual([
      `${SDK}-linux-arm64-musl/claude`,
      `${SDK}-linux-arm64/claude`,
    ]);
  });
});

describe("logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.resolvable.clear();
    h.resolvable.add(`${SDK}-${process.platform}-${process.arch}/claude`);
  });

  it("executes the native binary directly, not via node", async () => {
    mockSuccess("Logged out.");
    await logout();

    expect(mockExecFile).toHaveBeenCalledWith(
      `/mocked/node_modules/${SDK}-${process.platform}-${process.arch}/claude`,
      ["auth", "logout"],
      expect.any(Function),
    );
    // Regression guard: 0.3.x ships a native binary, not a JS entry point.
    expect(mockExecFile).not.toHaveBeenCalledWith(
      process.execPath,
      expect.anything(),
      expect.anything(),
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

  it("reports a clear failure when no platform package is installed", async () => {
    h.resolvable.clear();
    mockSuccess("should not run");

    const result = await logout();

    expect(result.success).toBe(false);
    expect(result.message).toContain("Could not locate the Claude Code binary");
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
