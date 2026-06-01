/**
 * Anthropic authentication preflight — runs before Kinetica credential collection.
 *
 * Determines the authentication method (API key or OAuth) and, when OAuth is
 * needed, creates a lightweight SDK query to drive the browser-based login flow.
 * This ensures the user authenticates with Anthropic *before* being asked for
 * Kinetica database credentials — fail fast if auth is impossible.
 *
 * The auth-only query is never iterated (no API tokens consumed). Once the
 * OAuth handshake completes, the query is aborted and the stored credentials
 * are picked up by the real agent query created later in runAgent().
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage, AccountInfo } from "@anthropic-ai/claude-agent-sdk";

import { resolveAuthentication } from "./oauth-flow.js";
import type { AuthResult } from "./oauth-flow.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for the authentication preflight check. */
export type AuthPreflightOptions = {
  readonly forceLogin: boolean;
  readonly loginMethod?: "claudeai" | "console";
  readonly loginOrgUUID?: string;
};

// ---------------------------------------------------------------------------
// Cached credential probe
// ---------------------------------------------------------------------------

/** Timeout for the cached credential probe (milliseconds). */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Probes the SDK query subprocess for cached OAuth credentials via `accountInfo()`.
 *
 * Returns an `AccountInfo` when the SDK already has valid tokens from a
 * previous session (at least `email` or `apiKeySource` present).
 * Returns `null` on failure, timeout, or empty response — caller should
 * fall through to the full OAuth browser flow.
 */
async function probeCachedCredentials(authQuery: {
  accountInfo(): Promise<AccountInfo>;
}): Promise<AccountInfo | null> {
  try {
    const info = await Promise.race([
      authQuery.accountInfo(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Probe timed out")), PROBE_TIMEOUT_MS),
      ),
    ]);
    if (info.email || info.apiKeySource) {
      return info;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Authenticates with Anthropic before collecting Kinetica credentials.
 *
 * - API key path: verifies ANTHROPIC_API_KEY is set, returns immediately.
 * - OAuth path: creates a minimal SDK query, runs the 3-step OAuth handshake
 *   (browser login), then aborts the query. Stored credentials are reused by
 *   the real agent query.
 * - Non-interactive + no API key: throws with a clear error message.
 *
 * @throws Error if no API key and terminal is non-interactive (OAuth impossible)
 */
export async function authenticateAnthropic(options: AuthPreflightOptions): Promise<AuthResult> {
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

  // Fast path: API key present and no forced login — no SDK round-trip needed
  if (hasApiKey && !options.forceLogin) {
    return { method: "api_key" };
  }

  // Non-interactive terminal cannot complete browser-based OAuth
  if (!process.stdin.isTTY) {
    throw new Error(
      "No ANTHROPIC_API_KEY set and terminal is non-interactive. " +
        "Set ANTHROPIC_API_KEY or run in an interactive terminal with --login.",
    );
  }

  // Build env for the auth-only query — strip API key when forcing OAuth
  const env = options.forceLogin
    ? (() => {
        const { ANTHROPIC_API_KEY: _stripped, ...rest } = process.env;
        return { ...rest, CLAUDE_AGENT_SDK_CLIENT_APP: "admin-agent" };
      })()
    : { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "admin-agent" };

  const abortController = new AbortController();

  // Blocks forever — keeps the query subprocess alive during browser login
  async function* hangingPrompt(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>(() => {});
  }

  const authQuery = query({
    prompt: hangingPrompt(),
    options: {
      persistSession: false,
      abortController,
      env,
      ...(options.loginMethod ? { forceLoginMethod: options.loginMethod } : {}),
      ...(options.loginOrgUUID ? { forceLoginOrgUUID: options.loginOrgUUID } : {}),
    },
  });

  try {
    // Probe for cached OAuth credentials (skip when user explicitly requests fresh login)
    if (!options.forceLogin) {
      const cached = await probeCachedCredentials(authQuery);
      if (cached) {
        return { method: "oauth", email: cached.email };
      }
    }

    return await resolveAuthentication(authQuery, {
      forceLogin: options.forceLogin,
      loginWithClaudeAi: (options.loginMethod ?? "claudeai") === "claudeai",
      hasApiKey,
    });
  } finally {
    abortController.abort();
    await authQuery.return().catch(() => {});
  }
}
