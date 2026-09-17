/**
 * Contract test: the SDK still ships its CLI where `binaryCandidates()` expects it.
 *
 * This file deliberately mocks NOTHING. Every test in `logout.test.ts` mocks
 * `node:module`, so they assert the shape of our candidate loop against a
 * fabricated tree — which is precisely the blind spot that let the 0.2 -> 0.3
 * packaging change (a bundled `cli.js` run under node, replaced by a native
 * per-platform binary) reach `--logout` with a green typecheck AND a green test
 * suite. `logout()` never throws, so it degraded to a quiet failure message.
 *
 * Resolving against the real installed `node_modules` is the only way to catch
 * the next such move: if the SDK renames the binary, drops the `/claude`
 * basename, or relocates it, CI fails here instead of a user's terminal.
 *
 * It lives in its own file because vitest mocks are file-scoped.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { binaryCandidates } from "./logout.js";

describe("SDK binary packaging contract", () => {
  it("ships an executable CLI at one of the paths binaryCandidates() names", () => {
    const require_ = createRequire(import.meta.url);
    const candidates = binaryCandidates(process.platform, process.arch, false);

    const resolved = candidates
      .map((candidate) => {
        try {
          return require_.resolve(candidate);
        } catch {
          return undefined;
        }
      })
      .find((path) => path !== undefined);

    expect(
      resolved,
      `No SDK binary resolved for ${process.platform}-${process.arch}. Tried: ${candidates.join(", ")}. ` +
        `The SDK's packaging may have changed — update binaryCandidates().`,
    ).toBeDefined();

    // execFile needs it to actually be a runnable file, not just present.
    const stats = statSync(resolved!);
    expect(stats.isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(stats.mode & 0o111).not.toBe(0);
    }
  });
});
