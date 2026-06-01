/**
 * Clears cached OAuth credentials by running the SDK's bundled CLI.
 *
 * The Claude Agent SDK stores OAuth tokens internally (managed by the CLI
 * subprocess). There is no SDK-level logout API, so we invoke the SDK's
 * bundled `cli.js` directly — this avoids requiring a global `claude`
 * install on the host.
 *
 * Never throws — returns a result object so the caller can report success
 * or failure without try/catch.
 */

import { execFile } from "child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Resolves the path to the Claude Agent SDK's bundled CLI script.
 *
 * The SDK's `exports` map doesn't expose `cli.js`, so we resolve the main
 * entry point (`sdk.mjs`) and compute the sibling path. This mirrors how
 * the SDK itself locates `cli.js` at runtime.
 *
 * Uses `__filename` (available in both CJS bundles and tsx dev mode).
 * Resolved lazily to avoid crashing at module load time.
 */
function resolveSdkCliPath(): string {
  const require_ = createRequire(__filename);
  return path.join(path.dirname(require_.resolve("@anthropic-ai/claude-agent-sdk")), "cli.js");
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
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      sdkCliPath,
      "auth",
      "logout",
    ]);
    const output = (stdout || stderr || "").trim();
    return { success: true, message: output || "Logged out successfully." };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Logout failed: ${message}` };
  }
}
