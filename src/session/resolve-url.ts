import pc from "picocolors";
import { confirm } from "@inquirer/prompts";

/** Timeout for each protocol probe request (ms). */
const PROBE_TIMEOUT_MS = 3_000;

/** Regex matching http:// or https:// at start of string (case-insensitive). */
const HTTP_PROTOCOL_RE = /^https?:\/\//i;

/** Regex matching any protocol scheme (e.g., ftp://, ws://). */
const ANY_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export type ResolveUrlResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: string };

export interface ResolveUrlOptions {
  /**
   * Force non-interactive behavior even in a TTY: never show the HTTP-downgrade
   * confirmation prompt — refuse the fallback as if stdin were not a terminal.
   * Used by best-effort, silent callers (e.g. bundle mode) that must never block.
   */
  readonly nonInteractive?: boolean;
}

/**
 * Returns true if the input starts with http:// or https:// (case-insensitive).
 * Pure function — no I/O.
 */
export function hasProtocol(input: string): boolean {
  return HTTP_PROTOCOL_RE.test(input);
}

/** Strips trailing slashes from a URL string. */
function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Probes a URL with a HEAD request to check if the server responds.
 * Any HTTP response (including 401, 500, etc.) counts as success —
 * we only care that the protocol reaches a listening server.
 * Never throws.
 */
async function probeProtocol(url: string): Promise<boolean> {
  try {
    await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

function isHttpsOnly(): boolean {
  return process.env.KINETICA_HTTPS_ONLY === "1";
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

/**
 * Prints a loud red warning to stderr about plaintext-HTTP credential exposure,
 * then asks the user to confirm the downgrade. Returns false if the user
 * declines or the prompt is interrupted (Ctrl-C).
 */
async function confirmHttpFallback(host: string): Promise<boolean> {
  process.stderr.write(
    "\n" +
      pc.red(
        pc.bold(
          `  WARNING: HTTPS unavailable at ${host}.\n` +
            `  Falling back to plaintext HTTP will transmit your Kinetica credentials in the clear.\n`,
        ),
      ) +
      pc.dim(
        `  Set KINETICA_HTTPS_ONLY=1 to refuse this fallback automatically, ` +
          `or pass an explicit http:// prefix to silence this prompt.\n\n`,
      ),
  );
  try {
    return await confirm({
      message: "Continue over plaintext HTTP?",
      default: false,
    });
  } catch {
    return false;
  }
}

/**
 * Resolves a raw URL input to a fully-qualified http:// or https:// URL.
 *
 * - If the input already has http:// or https://, returns it (normalized).
 * - If no protocol, probes https:// first.
 * - When HTTPS fails and HTTP would succeed, requires an explicit decision:
 *   - `KINETICA_HTTPS_ONLY=1` → refuse immediately, do not probe HTTP.
 *   - Interactive terminal → warn in red and require y/n confirmation.
 *   - Non-interactive terminal → refuse and suggest explicit `http://` prefix.
 * - Returns ok:false if the input is empty, uses an unsupported protocol,
 *   or no acceptable protocol probe succeeds.
 *
 * Never throws.
 */
export async function resolveUrl(
  input: string,
  options: ResolveUrlOptions = {},
): Promise<ResolveUrlResult> {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { ok: false, error: "URL is empty" };
  }

  const normalized = stripTrailingSlashes(trimmed);

  // Already has http:// or https:// — return as-is (explicit user choice)
  if (hasProtocol(normalized)) {
    return { ok: true, url: normalized };
  }

  // Has some other protocol (ftp://, ws://, etc.) — reject
  if (ANY_PROTOCOL_RE.test(normalized)) {
    const scheme = normalized.split("://")[0];
    return {
      ok: false,
      error: `Unsupported protocol: ${scheme}. Use http:// or https://`,
    };
  }

  // No protocol — probe HTTPS first
  const httpsUrl = `https://${normalized}`;
  const httpUrl = `http://${normalized}`;

  console.error(pc.dim("Detecting protocol..."));

  if (await probeProtocol(httpsUrl)) {
    return { ok: true, url: httpsUrl };
  }

  // HTTPS failed. Strict mode — refuse without probing HTTP.
  if (isHttpsOnly()) {
    return {
      ok: false,
      error:
        `HTTPS probe to ${httpsUrl} failed and KINETICA_HTTPS_ONLY=1; ` +
        `refusing to fall back to plaintext HTTP.`,
    };
  }

  if (!(await probeProtocol(httpUrl))) {
    return {
      ok: false,
      error: `Could not connect to ${normalized} via https:// or http://`,
    };
  }

  // HTTPS failed, HTTP would succeed — this is a credential-downgrade moment.
  // Non-interactive environments (or callers that opt out of prompting) cannot
  // consent; refuse by default.
  if (options.nonInteractive || !isInteractive()) {
    return {
      ok: false,
      error:
        `HTTPS unavailable at ${normalized} and terminal is non-interactive. ` +
        `Pass an explicit http:// prefix to allow plaintext HTTP, ` +
        `or point the URL at an HTTPS endpoint.`,
    };
  }

  const approved = await confirmHttpFallback(normalized);
  if (!approved) {
    return {
      ok: false,
      error: "User declined plaintext HTTP fallback",
    };
  }

  return { ok: true, url: httpUrl };
}
