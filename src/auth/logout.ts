/**
 * Clears cached OAuth credentials by running the SDK's bundled Claude Code CLI.
 *
 * The Claude Agent SDK stores OAuth tokens internally (managed by the CLI
 * subprocess). There is no SDK-level logout API, so we invoke the SDK's
 * bundled CLI directly — this avoids requiring a global `claude` install.
 *
 * SDK 0.3.x changed how that CLI ships. Through 0.2.x it was a JavaScript file
 * (`cli.js`) sitting beside `sdk.mjs`, run as `node <path>/cli.js`. From 0.3.x
 * it is a NATIVE per-platform binary delivered as an os/cpu-gated optional
 * dependency (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`), so it
 * is executed directly and `process.execPath` is no longer involved.
 *
 * The SDK resolves that binary internally but exports no helper for it, so the
 * candidate list below mirrors the SDK's own resolution order. Android is
 * deliberately omitted — the SDK publishes a variant, but it is not a
 * deployment target for this CLI.
 *
 * Never throws — returns a result object so the caller can report success
 * or failure without try/catch.
 */

import { execFile } from "child_process";
import { createRequire } from "node:module";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** The SDK package whose platform-specific siblings carry the binary. */
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * Returns true when this host is Linux without glibc — i.e. musl (Alpine).
 *
 * Mirrors the SDK's own detection: a musl process report carries no
 * `glibcVersionRuntime` header. Non-Linux platforms are never musl.
 *
 * Measured: the registry manifests DO declare `libc` (`glibc` / `musl`), so an
 * npm >= 10.4 install lands exactly one Linux variant and the ordering below is
 * moot. But `package-lock.json` records only `os`/`cpu` and drops `libc`, so a
 * lockfile-driven or older/alternative client can land BOTH — and then order
 * decides which binary runs, and a glibc build on Alpine fails. Ordering is kept
 * because it is correct either way; dropping it is correct only in the first case.
 */
function prefersMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report =
    typeof process.report?.getReport === "function" ? process.report.getReport() : null;
  if (report === null || typeof report !== "object") return false;
  const header = (report as { header?: { glibcVersionRuntime?: string } }).header;
  return header?.glibcVersionRuntime === undefined;
}

/**
 * Builds the ordered list of package-relative binary specifiers to try.
 *
 * Linux yields two candidates because a host can run either libc and only one
 * optional dependency installs; the likelier one is tried first. Every other
 * platform has exactly one. Pure — callers pass the platform triple in, which
 * keeps this testable without stubbing `process`.
 */
export function binaryCandidates(
  platform: NodeJS.Platform,
  arch: string,
  preferMusl: boolean,
): readonly string[] {
  const bin = (pkg: string): string => `${pkg}/claude${platform === "win32" ? ".exe" : ""}`;
  if (platform !== "linux") return [bin(`${SDK_PACKAGE}-${platform}-${arch}`)];

  const glibc = bin(`${SDK_PACKAGE}-linux-${arch}`);
  const musl = bin(`${SDK_PACKAGE}-linux-${arch}-musl`);
  return preferMusl ? [musl, glibc] : [glibc, musl];
}

/**
 * Resolves the path to the Claude Code native binary shipped with the SDK.
 *
 * Uses `__filename` (available in both CJS bundles and tsx dev mode). The
 * platform packages ship no `exports` map, so `require.resolve` performs plain
 * CJS file resolution and throws MODULE_NOT_FOUND unless the binary is on
 * disk — a successful resolve is itself proof of existence, and a throw is the
 * expected "not this platform" answer rather than an error, so the loop moves on.
 *
 * Throws only when no candidate resolves; `logout()` converts that into a
 * result object.
 */
function resolveSdkCliPath(): string {
  const require_ = createRequire(__filename);
  const candidates = binaryCandidates(process.platform, process.arch, prefersMusl());

  for (const candidate of candidates) {
    try {
      return require_.resolve(candidate);
    } catch {
      // Candidate not installed on this platform — try the next.
    }
  }

  throw new Error(
    `Could not locate the Claude Code binary. Tried: ${candidates.join(", ")}. ` +
      `The SDK's platform-specific optional dependency may not be installed — ` +
      `try reinstalling dependencies.`,
  );
}

/** Result of a logout attempt. */
export type LogoutResult = {
  readonly success: boolean;
  readonly message: string;
};

/**
 * Logs out of the Anthropic account by running `claude auth logout`.
 *
 * @returns A result indicating whether logout succeeded, with a human-readable message
 */
export async function logout(): Promise<LogoutResult> {
  try {
    const sdkCliPath = resolveSdkCliPath();
    const { stdout, stderr } = await execFileAsync(sdkCliPath, ["auth", "logout"]);
    const output = (stdout || stderr || "").trim();
    return { success: true, message: output || "Logged out successfully." };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Logout failed: ${message}` };
  }
}
