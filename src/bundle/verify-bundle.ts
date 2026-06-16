/**
 * verify-bundle — validate a bundle path and build its source, the offline
 * analogue of session/verify.ts `connectWithRetry`.
 *
 * Mirrors the degraded-mode philosophy: a missing or unreadable artifact is a
 * warning, not a hard failure — we diagnose with what's present and surface the
 * gaps. Only an unusable path (does not exist, is a not-yet-extracted archive,
 * or has no readable files) is a hard error.
 *
 * Never throws — returns a discriminated result the CLI branches on.
 */

import { stat } from "node:fs/promises";
import { createBundleSource, type BundleSource, type BundleInventory } from "./BundleSource.js";
import type { BundleFileKind } from "./classify-file.js";

// Re-exported for callers that imported the inventory type from here; the single
// definition now lives with the BundleSource that produces it.
export type { BundleInventory };

export type BundleVerifyResult =
  | {
      readonly ok: true;
      readonly bundleSource: BundleSource;
      readonly kineticaVersion?: string;
      readonly inventory: BundleInventory;
      /** Expected-but-absent artifact kinds (e.g. "config", "core-log"). Non-fatal. */
      readonly missingExpected: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

const ARCHIVE_RE = /\.(tgz|tar\.gz|tar|gz|zip)$/i;
const EXPECTED_KINDS: readonly BundleFileKind[] = ["config", "core-log"];

export async function verifyBundle(bundlePath: string): Promise<BundleVerifyResult> {
  let info;
  try {
    info = await stat(bundlePath);
  } catch {
    return { ok: false, error: `bundle path does not exist: ${bundlePath}` };
  }

  if (!info.isDirectory()) {
    if (ARCHIVE_RE.test(bundlePath)) {
      return {
        ok: false,
        error: `bundle mode expects an extracted directory, not an archive. Run \`tar xzf ${bundlePath}\` and pass the resulting directory.`,
      };
    }
    return { ok: false, error: `bundle path is not a directory: ${bundlePath}` };
  }

  const bundleSource = await createBundleSource(bundlePath);
  const inventory = bundleSource.inventory();
  if (inventory.totalFiles === 0) {
    return { ok: false, error: `no readable files found in bundle directory: ${bundlePath}` };
  }

  const missingExpected = EXPECTED_KINDS.filter((k) => (inventory.byKind[k] ?? 0) === 0);
  const kineticaVersion = await bundleSource.detectVersion();

  return {
    ok: true,
    bundleSource,
    ...(kineticaVersion !== undefined ? { kineticaVersion } : {}),
    inventory,
    missingExpected,
  };
}
