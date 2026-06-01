import pc from "picocolors";
import { confirm } from "@inquirer/prompts";
import { collectCredentials, repromptCredentials } from "./collect.js";
import { createSession } from "./KineticaSession.js";
import { offerSaveCredentials } from "./env-file.js";
import { resolveUrl } from "./resolve-url.js";
import type { KineticaSession } from "../types/index.js";

const MAX_RETRIES = 3;

/** Maximum number of credential re-prompt cycles before giving up. */
const MAX_REPROMPTS = 2;

/** Default Kinetica host manager port — hardcoded for degraded mode (cannot discover via 9191). */
const DEFAULT_HM_PORT = 9300;

export type ConnectResult = {
  readonly session: KineticaSession;
  readonly kineticaVersion: string | undefined;
  readonly degraded: boolean;
};

export type HostManagerProbeResult =
  | { readonly ok: true; readonly version: string | undefined }
  | { readonly ok: false };

/**
 * Extracts the Kinetica version from a /show/system/status JSON response body.
 * Looks for `version.gpudb_core_version` in the `status_map.system` JSON string.
 * Returns undefined if the version cannot be extracted (never throws).
 */
export function extractVersion(responseBody: string): string | undefined {
  try {
    const outer = JSON.parse(responseBody) as { data_str?: string };
    if (typeof outer.data_str !== "string") return undefined;
    const inner = JSON.parse(outer.data_str) as { status_map?: Record<string, string> };
    const systemStr = inner.status_map?.system;
    if (typeof systemStr !== "string") return undefined;
    const system = JSON.parse(systemStr) as { version?: string };
    return typeof system.version === "string" ? system.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extracts the Kinetica version from a host manager root endpoint response.
 * The HM response is flat JSON with a top-level `version` field.
 * Returns undefined if the version cannot be extracted (never throws).
 */
export function extractVersionFromHostManager(responseBody: string): string | undefined {
  try {
    const parsed = JSON.parse(responseBody) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Probes the host manager root endpoint on port 9300 as a fallback when the
 * DB engine (port 9191) is unreachable. Returns a discriminated union:
 * - ok:true with version when HM responds with 200
 * - ok:false when HM is unreachable or makeRequestToPort is unavailable
 *
 * Never throws — all error paths return { ok: false }.
 */
export async function probeHostManager(session: KineticaSession): Promise<HostManagerProbeResult> {
  if (!session.makeRequestToPort) {
    return { ok: false };
  }
  try {
    const response = await session.makeRequestToPort(DEFAULT_HM_PORT, "/", undefined);
    if (!response.ok) return { ok: false };
    const body = await response.text();
    return { ok: true, version: extractVersionFromHostManager(body) };
  } catch {
    return { ok: false };
  }
}

/**
 * Verifies connectivity to Kinetica by making a lightweight request to
 * the system status endpoint. Throws on non-200 responses with status code in message.
 * Returns the Kinetica version string if extractable (best-effort, never fails on this).
 */
export async function verifyConnectivity(session: KineticaSession): Promise<string | undefined> {
  const response = await session.makeRequest("/show/system/status", {});
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body}`);
  }
  const body = await response.text();
  return extractVersion(body);
}

/**
 * Returns true if the error message indicates an authentication or
 * authorization failure (HTTP 401/403). These are deterministic —
 * retrying with the same credentials will not help.
 */
export function isCredentialError(errorMessage: string): boolean {
  return errorMessage.startsWith("HTTP 401") || errorMessage.startsWith("HTTP 403");
}

/**
 * Collects credentials once, creates a session, and verifies connectivity.
 * Retries the connection up to MAX_RETRIES times on failure.
 *
 * On credential errors (401/403), offers to re-prompt for username and
 * password instead of retrying with the same bad credentials. New credentials
 * get a fresh set of retries. Exits immediately if the user declines or
 * the terminal is non-interactive.
 *
 * After exhausting retries on port 9191, attempts a host manager fallback
 * on port 9300. If the HM responds, returns in degraded mode (degraded: true).
 * Exits with code 1 only when both 9191 and 9300 are unreachable.
 *
 * Returns the session, Kinetica version (if detected), and degraded flag.
 */
export async function connectWithRetry(): Promise<ConnectResult> {
  const { credentials, prompted } = await collectCredentials();

  // Resolve protocol if missing (probes https first, then http)
  const resolved = await resolveUrl(credentials.url);
  if (!resolved.ok) {
    console.error(pc.red(resolved.error));
    process.exit(1);
  }
  const resolvedUrl = resolved.url;

  let currentUser = credentials.user;
  let currentPass = credentials.pass;
  let wasReprompted = false;
  let repromptCount = 0;
  let session = createSession(resolvedUrl, currentUser, currentPass);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const kineticaVersion = await verifyConnectivity(session);
      console.error(pc.green("Connected to Kinetica successfully."));
      if (prompted.size > 0 || wasReprompted) {
        await offerSaveCredentials(resolvedUrl, currentUser);
      }
      return { session, kineticaVersion, degraded: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(pc.red(`Connection failed (attempt ${attempt}/${MAX_RETRIES}): ${msg}`));

      // Credential errors are deterministic — offer re-prompt instead of blind retry
      if (isCredentialError(msg)) {
        if (process.stdin.isTTY && repromptCount < MAX_REPROMPTS) {
          const shouldRetry = await confirm({
            message: "Credentials may be incorrect. Re-enter?",
            default: true,
          });
          if (shouldRetry) {
            const fresh = await repromptCredentials();
            currentUser = fresh.user;
            currentPass = fresh.pass;
            wasReprompted = true;
            repromptCount++;
            session = createSession(resolvedUrl, currentUser, currentPass);
            attempt = 0; // Reset — incremented to 1 by the for-loop
            continue;
          }
        }
        // User declined, non-interactive, or exhausted re-prompts
        console.error(pc.red("Authentication failed. Exiting."));
        process.exit(1);
      }

      if (attempt === MAX_RETRIES) {
        // Attempt host manager fallback on port 9300
        console.error(pc.yellow("DB engine unreachable. Probing host manager on port 9300..."));
        const hmResult = await probeHostManager(session);
        if (hmResult.ok) {
          console.error(
            pc.yellow(
              "Connected in DEGRADED MODE (host manager only). Most diagnostic tools will be unavailable.",
            ),
          );
          if (prompted.size > 0 || wasReprompted) {
            await offerSaveCredentials(resolvedUrl, currentUser);
          }
          return { session, kineticaVersion: hmResult.version, degraded: true };
        }
        console.error(pc.red("Host manager also unreachable. Exiting."));
        process.exit(1);
      }
    }
  }
  // Unreachable — loop always returns or exits, but TypeScript needs this
  /* c8 ignore next */
  throw new Error("unreachable");
}
