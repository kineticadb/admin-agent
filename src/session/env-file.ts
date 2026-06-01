import { readFileSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { confirm } from "@inquirer/prompts";
import pc from "picocolors";

/**
 * Parses .env file content into a key-value map.
 * Skips blank lines and comment lines (starting with #).
 * Strips surrounding double or single quotes from values.
 * For double-quoted values, unescapes `\"` and `\\` (symmetric with
 * buildEnvContent's escaping when a value contains special characters).
 *
 * Pure function — no I/O, no side effects.
 */
export function parseEnvContent(content: string): ReadonlyMap<string, string> {
  const entries: Array<[string, string]> = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_]\w*)=(.*)/.exec(trimmed);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    // Strip surrounding quotes and unescape quoted forms
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\(["\\])/g, "$1");
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    entries.push([key, value]);
  }
  return new Map(entries);
}

/**
 * Characters forbidden in env values written by buildEnvContent.
 * Newlines would inject extra env vars into the file; null bytes can
 * terminate the value on some consumers. Any of these triggers a throw.
 */
const FORBIDDEN_VALUE_CHARS = /[\n\r\0]/;

/**
 * Characters that require quoting in an env value. Whitespace, # (comment
 * marker), and existing quotes all interact with the parser. When none are
 * present, we emit the value unquoted for minimal diff on existing files.
 */
const REQUIRES_QUOTING = /[\s"'#]/;

/**
 * Escapes an env value for safe write-out.
 *
 * - Throws on newlines or null bytes (these corrupt the file silently).
 * - Returns the value unmodified if it contains no whitespace, #, or quotes.
 * - Otherwise returns a double-quoted, backslash-escaped form that round-trips
 *   through parseEnvContent.
 *
 * Exported for testing.
 */
export function escapeEnvValue(value: string): string {
  if (FORBIDDEN_VALUE_CHARS.test(value)) {
    throw new Error(
      "Env value contains a forbidden character (newline or null byte); refusing to write",
    );
  }
  if (!REQUIRES_QUOTING.test(value)) {
    return value;
  }
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Template matching .env.example format.
 * Keep in sync with .env.example at the repository root.
 */
const ENV_TEMPLATE = `# Anthropic API key (optional — if not set, OAuth login via browser is used)
ANTHROPIC_API_KEY=

# Kinetica connection details (prompted interactively if not set)
# If password is omitted, the agent will prompt for it at startup
KINETICA_URL={url}
KINETICA_USER={user}
KINETICA_PASS=
`;

/**
 * Builds .env file content with URL and user filled in.
 *
 * If existingContent is provided (and non-empty), replaces KINETICA_URL= and
 * KINETICA_USER= lines in-place. Appends any missing keys. Never touches
 * KINETICA_PASS or any other line.
 *
 * If no existing content, generates from the template.
 *
 * Pure function — no I/O, no side effects.
 */
export function buildEnvContent(url: string, user: string, existingContent?: string): string {
  const safeUrl = escapeEnvValue(url);
  const safeUser = escapeEnvValue(user);

  if (!existingContent?.trim()) {
    return ENV_TEMPLATE.replace("{url}", safeUrl).replace("{user}", safeUser);
  }

  const lines = existingContent.split("\n");
  let urlReplaced = false;
  let userReplaced = false;

  const updated = lines.map((line) => {
    if (/^KINETICA_URL=/.exec(line)) {
      urlReplaced = true;
      return `KINETICA_URL=${safeUrl}`;
    }
    if (/^KINETICA_USER=/.exec(line)) {
      userReplaced = true;
      return `KINETICA_USER=${safeUser}`;
    }
    return line;
  });

  if (!urlReplaced) updated.push(`KINETICA_URL=${safeUrl}`);
  if (!userReplaced) updated.push(`KINETICA_USER=${safeUser}`);

  return updated.join("\n");
}

/**
 * Loads a .env file from the specified directory (default: cwd) and populates
 * the environment object for any keys not already set.
 *
 * Shell-set env vars always take precedence over .env file values.
 * Never throws — missing file or parse errors are silently ignored.
 */
export function loadEnvFile(dir?: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const filePath = join(dir ?? process.cwd(), ".env");
    const content = readFileSync(filePath, "utf8");
    const parsed = parseEnvContent(content);
    for (const [key, value] of parsed) {
      if (env[key] === undefined && value !== "") {
        env[key] = value;
      }
    }
  } catch {
    // No .env file or read error — continue without it
  }
}

/**
 * Offers to save KINETICA_URL and KINETICA_USER to a .env file after a
 * successful interactive connection. Password is never saved.
 *
 * Skips silently in non-interactive terminals. Never throws.
 */
export async function offerSaveCredentials(url: string, user: string, dir?: string): Promise<void> {
  if (!process.stdin.isTTY) return;

  try {
    const shouldSave = await confirm({
      message: "Save KINETICA_URL and KINETICA_USER to .env? (password is never saved)",
      default: true,
    });

    if (!shouldSave) return;

    const filePath = join(dir ?? process.cwd(), ".env");
    let existing: string | undefined;
    try {
      existing = await readFile(filePath, "utf8");
    } catch {
      // File doesn't exist yet — will create from template
    }

    const content = buildEnvContent(url, user, existing);
    await writeFile(filePath, content, "utf8");
    console.error(pc.dim("Saved to .env"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(pc.yellow(`Could not save .env file: ${message}`));
  }
}
