import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSpinner } from "./spinner.js";

describe("createSpinner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns a frozen object", () => {
    const spinner = createSpinner();
    expect(Object.isFrozen(spinner)).toBe(true);
  });

  it("starts and reports isRunning", () => {
    const spinner = createSpinner();
    expect(spinner.isRunning()).toBe(false);
    spinner.start();
    expect(spinner.isRunning()).toBe(true);
    spinner.stop();
  });

  it("writes braille frames to stderr on interval", () => {
    const spinner = createSpinner();
    spinner.start();

    vi.advanceTimersByTime(80);
    const calls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);

    // First frame should contain the braille character and default label
    const firstOutput = calls[0][0] as string;
    expect(firstOutput).toContain("Thinking...");

    spinner.stop();
  });

  it("accepts a custom label", () => {
    const spinner = createSpinner();
    spinner.start("Investigating");

    vi.advanceTimersByTime(80);
    const calls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    const firstOutput = calls[0][0] as string;
    expect(firstOutput).toContain("Investigating...");

    spinner.stop();
  });

  it("start is idempotent — second call is a no-op", () => {
    const spinner = createSpinner();
    spinner.start();
    vi.advanceTimersByTime(80);

    const writeMock = process.stderr.write as ReturnType<typeof vi.fn>;
    const countBefore = writeMock.mock.calls.length;

    spinner.start(); // should not create a second interval
    vi.advanceTimersByTime(80);

    // Only one additional frame, not two (would be two if two intervals)
    const countAfter = writeMock.mock.calls.length;
    expect(countAfter - countBefore).toBe(1);

    spinner.stop();
  });

  it("stop clears the line with CR + ANSI erase", () => {
    const spinner = createSpinner();
    spinner.start();
    vi.advanceTimersByTime(80);

    const writeMock = process.stderr.write as ReturnType<typeof vi.fn>;
    writeMock.mockClear();

    spinner.stop();
    expect(writeMock).toHaveBeenCalledWith("\r\x1b[K");
    expect(spinner.isRunning()).toBe(false);
  });

  it("stop is idempotent — no-op when not running", () => {
    const spinner = createSpinner();
    const writeMock = process.stderr.write as ReturnType<typeof vi.fn>;

    spinner.stop(); // should not throw or write anything
    expect(writeMock).not.toHaveBeenCalled();
    expect(spinner.isRunning()).toBe(false);
  });

  it("unrefs the timer so it does not keep the event loop alive", () => {
    // Spy on setInterval to capture the returned timer and verify .unref() was called
    const realSetInterval = globalThis.setInterval;
    const unrefSpy = vi.fn();
    vi.spyOn(globalThis, "setInterval").mockImplementation(
      (...args: Parameters<typeof setInterval>) => {
        const timer = realSetInterval(...args);
        timer.unref = unrefSpy;
        return timer;
      },
    );

    const spinner = createSpinner();
    spinner.start();
    expect(unrefSpy).toHaveBeenCalledOnce();
    spinner.stop();

    vi.mocked(globalThis.setInterval).mockRestore();
  });

  it("can restart after stop", () => {
    const spinner = createSpinner();
    spinner.start();
    vi.advanceTimersByTime(80);
    spinner.stop();

    expect(spinner.isRunning()).toBe(false);

    spinner.start("Resuming");
    expect(spinner.isRunning()).toBe(true);
    vi.advanceTimersByTime(80);

    const calls = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls;
    const lastOutput = calls[calls.length - 1][0] as string;
    expect(lastOutput).toContain("Resuming...");

    spinner.stop();
  });
});
