import { confirm, input, password } from "@inquirer/prompts";
import pc from "picocolors";
import type { Credentials } from "../types/index.js";

export type CollectResult = {
  readonly credentials: Credentials;
  readonly prompted: ReadonlySet<"url" | "user">;
};

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
  const prompted = new Set<"url" | "user">();

  const envUrl = process.env.KINETICA_URL;
  const envUser = process.env.KINETICA_USER;

  // If a saved connection exists and terminal is interactive, let the user choose
  if (envUrl && envUser && process.stdin.isTTY) {
    console.error(pc.dim(`Saved connection: ${envUrl} (${envUser})`));
    const useSaved = await confirm({
      message: "Use saved connection?",
      default: true,
    });
    if (!useSaved) {
      prompted.add("url");
      prompted.add("user");
      const url = await input({ message: "Kinetica endpoint URL:" });
      const user = await input({ message: "Admin username:" });
      const pass = await password({ message: "Admin password:", mask: "*" });
      return { credentials: { url, user, pass }, prompted };
    }
  }

  const url = envUrl ?? (prompted.add("url"), await input({ message: "Kinetica endpoint URL:" }));
  const user = envUser ?? (prompted.add("user"), await input({ message: "Admin username:" }));

  const pass =
    process.env.KINETICA_PASS ?? (await password({ message: "Admin password:", mask: "*" }));

  return { credentials: { url, user, pass }, prompted };
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
