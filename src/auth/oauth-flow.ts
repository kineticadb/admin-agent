/**
 * OAuth login flow for the Claude Agent SDK.
 *
 * Drives the 3-step OAuth handshake using undeclared methods on the SDK's
 * Query object (present at runtime in sdk.mjs but omitted from sdk.d.ts).
 * The OAuthCapableQuery interface provides TypeScript coverage for these methods.
 *
 * The flow:
 * 1. claudeAuthenticate(loginWithClaudeAi) → returns { manualUrl, automaticUrl }
 * 2. Open browser with automaticUrl (fallback: print manualUrl)
 * 3. claudeOAuthWaitForCompletion() → blocks until user completes browser login
 *
 * All errors are caught — never throws. On failure, returns a result with
 * a warning to stderr so the SDK can still attempt to proceed.
 */

import pc from "picocolors";
import { openBrowser } from "./open-browser.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Extended Query interface exposing undeclared OAuth methods present at runtime.
 *
 * These methods exist on the Query prototype in sdk.mjs but are intentionally
 * omitted from sdk.d.ts (blank lines at lines 1532-1536). The SDK version is
 * pinned to ~0.2.80 (patch only) to reduce breakage risk.
 */
export interface OAuthCapableQuery {
  claudeAuthenticate(loginWithClaudeAi: boolean): Promise<{
    readonly manualUrl: string;
    readonly automaticUrl: string;
  }>;
  claudeOAuthWaitForCompletion(): Promise<unknown>;
}

/** Result of the authentication resolution. */
export type AuthResult = {
  readonly method: "api_key" | "oauth";
  readonly email?: string;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Determines whether OAuth login is needed and runs the flow if so.
 *
 * OAuth is triggered when:
 * 1. No ANTHROPIC_API_KEY is set (hasApiKey = false), OR
 * 2. forceLogin is true (--login flag)
 *
 * @param agentQuery - The Query object returned by the SDK's query() function
 * @param options - Authentication configuration
 * @returns AuthResult describing which method was used
 */
export async function resolveAuthentication(
  agentQuery: unknown,
  options: {
    readonly forceLogin: boolean;
    readonly loginWithClaudeAi: boolean;
    readonly hasApiKey: boolean;
  },
): Promise<AuthResult> {
  // Fast path: API key present and no forced login
  if (options.hasApiKey && !options.forceLogin) {
    return { method: "api_key" };
  }

  // OAuth path: cast to access undeclared methods
  const query = agentQuery as OAuthCapableQuery;

  try {
    // Step 1: Initiate OAuth flow — SDK returns login URLs
    const { manualUrl, automaticUrl } = await query.claudeAuthenticate(options.loginWithClaudeAi);

    // Step 2: Open browser (with manual URL fallback)
    const opened = openBrowser(automaticUrl);
    if (opened) {
      process.stderr.write(pc.dim("Browser opened for login. Waiting for authentication...\n"));
    } else {
      process.stderr.write(`\nOpen this URL in your browser to log in:\n${pc.bold(manualUrl)}\n\n`);
      process.stderr.write(pc.dim("Waiting for browser login to complete...\n"));
    }

    // Step 3: Wait for user to complete browser authorization
    await query.claudeOAuthWaitForCompletion();

    return { method: "oauth" };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      pc.yellow(`\nWarning: OAuth login failed (${message}). SDK may retry automatically.\n`),
    );
    return { method: "oauth" };
  }
}
