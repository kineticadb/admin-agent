import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn } from "child_process";
import { openBrowser } from "./open-browser.js";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(spawn);

function makeMockChild() {
  const child = { unref: vi.fn(), on: vi.fn() } as unknown as ReturnType<typeof spawn>;
  return child;
}

describe("openBrowser", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns 'open' on macOS", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockSpawn.mockReturnValue(makeMockChild());

    openBrowser("https://example.com");

    expect(mockSpawn).toHaveBeenCalledWith("open", ["https://example.com"], {
      detached: true,
      stdio: "ignore",
    });
    Object.defineProperty(process, "platform", { value: original });
  });

  it("spawns 'xdg-open' on Linux", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    mockSpawn.mockReturnValue(makeMockChild());

    openBrowser("https://example.com");

    expect(mockSpawn).toHaveBeenCalledWith("xdg-open", ["https://example.com"], {
      detached: true,
      stdio: "ignore",
    });
    Object.defineProperty(process, "platform", { value: original });
  });

  it("spawns 'cmd /c start' on Windows", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    mockSpawn.mockReturnValue(makeMockChild());

    openBrowser("https://example.com");

    expect(mockSpawn).toHaveBeenCalledWith("cmd", ["/c", "start", "", "https://example.com"], {
      detached: true,
      stdio: "ignore",
    });
    Object.defineProperty(process, "platform", { value: original });
  });

  it("calls unref() on the spawned child", () => {
    const child = makeMockChild();
    mockSpawn.mockReturnValue(child);

    openBrowser("https://example.com");

    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("returns true on successful spawn", () => {
    mockSpawn.mockReturnValue(makeMockChild());
    expect(openBrowser("https://example.com")).toBe(true);
  });

  it("returns false when spawn throws", () => {
    mockSpawn.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    expect(openBrowser("https://example.com")).toBe(false);
  });
});
