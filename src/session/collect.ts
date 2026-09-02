import { confirm, input, password } from "../output/themed-prompts.js";
import pc from "picocolors";
import type { Credentials } from "../types/index.js";
import { readStatsHostEnv } from "../observability/discover.js";

export type CollectResult = {
  readonly credentials: Credentials;
  readonly prompted: ReadonlySet<"url" | "user" | "statsHost">;
};

/**
 * Ask for the Prometheus/Loki host, immediately after the password.
 *
 * Asked up front rather than derived from gpudb.conf: that file names the cluster's
 * INTERNAL address, which usually does not route from where the agent runs, so deriving
 * it would mostly produce something unreachable and a second prompt later. Blank is a
 * first-class answer — plenty of clusters have no stats stack.
 *
 * The example is deliberately port-less, and sits right after an endpoint example that
 * DOES carry one (`http://dbhost:9191`) — the contrast is the hint. Ports here are per
 * SERVICE and derived, not per host: Prometheus at 9090, Loki at gaia.event_server_port
 * (default 9080). A port typed here would be ambiguous about which service it meant, so
 * discover.ts discards it.
 */
async function promptStatsHost(): Promise<string | undefined> {
  const answer = await input({
    message: "Prometheus/Loki host URL (e.g. http://statshost, blank if none):",
  });
  const trimmed = answer.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Collects Kinetica credentials from environment variables with
 * interactive prompt fallback for any missing values.
 *
 * When both URL and user are available from env and the terminal is
 * interactive, displays the saved connection and asks the user to
 * confirm or enter new credentials.
 *
 * Priority: env var > interactive prompt
 * - KINETICA_URL   → url
 * - KINETICA_USER  → user
 * - KINETICA_PASS  → pass (password prompt with mask)
 *
 * Returns credentials plus a set of field names that were collected
 * via interactive prompt (used to decide whether to offer .env save).
 */
export async function collectCredentials(): Promise<CollectResult> {
  const prompted = new Set<"url" | "user" | "statsHost">();

  const envUrl = process.env.KINETICA_URL;
  const envUser = process.env.KINETICA_USER;
  const envStatsHost = readStatsHostEnv();

  // If a saved connection exists and terminal is interactive, let the user choose
  // Confirming a saved connection is the "ask me nothing" path — adding a question there
  // would nag every launch of a cluster with no stats stack, since a blank answer cannot
  // be remembered (loadEnvFile skips empty values so prompts still fire).
  let usedSavedConnection = false;

  if (envUrl && envUser && process.stdin.isTTY) {
    const statsNote = envStatsHost ? `, stats ${envStatsHost}` : "";
    console.error(pc.dim(`Saved connection: ${envUrl} (${envUser})${statsNote}`));
    const useSaved = await confirm({
      message: "Use saved connection?",
      default: true,
    });
    usedSavedConnection = useSaved;
    if (!useSaved) {
      prompted.add("url");
      prompted.add("user");
      const url = await input({ message: "Kinetica endpoint URL (e.g. http://dbhost:9191):" });
      const user = await input({ message: "Admin username:" });
      const pass = await password({ message: "Admin password:", mask: "*" });
      prompted.add("statsHost");
      const statsHost = await promptStatsHost();
      return { credentials: { url, user, pass, statsHost }, prompted };
    }
  }

  const url =
    envUrl ??
    (prompted.add("url"),
    await input({ message: "Kinetica endpoint URL (e.g. http://dbhost:9191):" }));
  const user = envUser ?? (prompted.add("user"), await input({ message: "Admin username:" }));

  const pass =
    process.env.KINETICA_PASS ?? (await password({ message: "Admin password:", mask: "*" }));

  // Asked only when not already known and someone is there to answer — a non-interactive
  // run must never block, and simply has no metrics unless the env var is set.
  const statsHost =
    envStatsHost ??
    (process.stdin.isTTY && !usedSavedConnection
      ? (prompted.add("statsHost"), await promptStatsHost())
      : undefined);

  return { credentials: { url, user, pass, statsHost }, prompted };
}

/**
 * Re-prompts for username and password interactively.
 * Always prompts (ignores env vars) — used when credentials are rejected.
 * Returns only user + pass; the URL is assumed unchanged.
 */
export async function repromptCredentials(): Promise<{
  readonly user: string;
  readonly pass: string;
}> {
  const user = await input({ message: "Admin username:" });
  const pass = await password({ message: "Admin password:", mask: "*" });
  return { user, pass };
}
