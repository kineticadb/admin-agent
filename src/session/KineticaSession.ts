import type { KineticaSession } from "../types/index.js";

/** Default request timeout in milliseconds (30 seconds). */
const REQUEST_TIMEOUT_MS = 30_000;

/** Optional session tuning. */
export interface SessionOptions {
  /**
   * Per-request timeout in milliseconds. Defaults to REQUEST_TIMEOUT_MS (30s).
   * A shorter value is used for the bundle-mode best-effort probe so a wedged
   * DB engine can't freeze startup for the full default timeout.
   */
  readonly timeoutMs?: number;
}

/**
 * Creates a KineticaSession with credentials captured in a closure.
 * The returned session object exposes only baseUrl and makeRequest —
 * credentials (user, pass) are unreachable from outside this function.
 * This satisfies SAFE-03: credentials never appear in the agent context.
 */
/** Replace the port in a URL string. */
function replacePort(baseUrl: string, port: number): string {
  const parsed = new URL(baseUrl);
  parsed.port = String(port);
  // Remove trailing slash for consistency with makeRequest
  return parsed.origin;
}

export function createSession(
  url: string,
  user: string,
  pass: string,
  options?: SessionOptions,
): KineticaSession {
  // Credentials captured in closure — unreachable from outside this function
  const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const doFetch = async (fullUrl: string, body?: unknown): Promise<Response> => {
    if (process.env.DEBUG) {
      console.error(`[DEBUG] POST ${fullUrl}`);
    }
    return fetch(fullUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  return {
    baseUrl: url,
    makeRequest: (endpoint: string, body?: unknown) => doFetch(`${url}${endpoint}`, body),
    makeRequestToPort: (port: number, endpoint: string, body?: unknown) =>
      doFetch(`${replacePort(url, port)}${endpoint}`, body),
  };
}
