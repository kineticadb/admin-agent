/**
 * Tests for the operator-facing save confirmation.
 *
 * The two non-obvious contracts are the ones a widget lives or dies by: a
 * non-interactive run must never BLOCK on a prompt nobody can answer, and an
 * aborted prompt must resolve rather than throw into the tool handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../output/themed-prompts.js", () => ({ confirm: vi.fn() }));

import { confirm } from "../output/themed-prompts.js";
import { promptSaveReport } from "./confirm-save.js";

const mockConfirm = vi.mocked(confirm);

/** Set process.stdin.isTTY for one test; restored in afterEach. */
function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

const originalIsTty = process.stdin.isTTY;

describe("promptSaveReport", () => {
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    setTty(Boolean(originalIsTty));
    vi.restoreAllMocks();
  });

  describe("interactive terminal", () => {
    beforeEach(() => setTty(true));

    it("returns true when the operator accepts", async () => {
      mockConfirm.mockResolvedValueOnce(true);
      await expect(promptSaveReport()).resolves.toBe(true);
    });

    it("returns false when the operator declines", async () => {
      mockConfirm.mockResolvedValueOnce(false);
      await expect(promptSaveReport()).resolves.toBe(false);
    });

    it("defaults to yes, so a bare Enter saves", async () => {
      mockConfirm.mockResolvedValueOnce(true);
      await promptSaveReport();
      const [config] = mockConfirm.mock.calls[0];
      expect((config as { default?: boolean }).default).toBe(true);
    });

    it("declines rather than throwing when the prompt is aborted (Ctrl-C)", async () => {
      mockConfirm.mockRejectedValueOnce(new Error("User force closed the prompt"));
      await expect(promptSaveReport()).resolves.toBe(false);
    });
  });

  describe("non-interactive terminal", () => {
    beforeEach(() => setTty(false));

    it("returns true without prompting, so a piped or CI run still produces a report", async () => {
      await expect(promptSaveReport()).resolves.toBe(true);
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    it("records on stderr that consent was assumed rather than given", async () => {
      await promptSaveReport();
      const written = (stderr.mock.calls as unknown[][]).map((c) => String(c[0])).join("");
      expect(written).toMatch(/non-interactive/i);
    });
  });
});
