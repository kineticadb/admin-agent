/**
 * Credential scrubbing utility for diagnostic reports.
 *
 * Provides a pure function that removes sensitive credentials from report content
 * before writing to disk. Defense-in-depth on top of Phase 1 credential isolation:
 * even if tool error messages contain URL fragments, they are stripped.
 *
 * Exports:
 *   DEFAULT_SCRUB_PATTERNS — readonly array of RegExp patterns for common credential formats
 *   CONFIG_SECRET_PATTERN  — RegExp matching sensitive INI `key = value` lines (gpudb.conf)
 *   redactConfigSecrets(content) — masks values of sensitive INI keys, preserving the key name
 *   scrubCredentials(content, patterns?) — pure function returning new string with credentials removed
 */

/**
 * Credential words. Redacted wherever they appear in a key name, because a
 * position-only rule leaks: `private_key_pem` and `bind_password_value` are
 * secrets whose credential word is not the final token.
 */
const SECRET_KEY_WORDS =
  "password|passwd|passphrase|secret|token|credential|apikey|" +
  String.raw`(?:license|private|public|api|access|signing|encryption` +
  String.raw`|account|handshake|customer|master|session)[_.-]?key`;

/**
 * Final tokens that mark a key as a policy setting or a filesystem path rather
 * than a credential, even when a credential word appears earlier in the name.
 *
 * This is the narrow exception that keeps `min_password_length` (a policy the
 * agent must read to diagnose weak auth) and `ssl_key_file` (a path) visible.
 * Unknown keys fall through to redaction, so the list fails safe.
 */
/**
 * Leading tokens that mark a key as a boolean flag rather than a credential --
 * `use_managed_credentials` is on/off, and hiding it costs cloud-tier diagnosis.
 */
const FLAG_LEADING_TOKENS = "use|enable|disable|allow|require|is|has";

const NON_SECRET_FINAL_TOKENS =
  "length|min|max|age|policy|expiry|history|complexity|enabled|" +
  "file|path|dir|directory|ciphers|timeout|count|port|type|algorithm";

/** A bare `key` suffix is a credential: `ai.api.key`, `handshake_key`. */
const SECRET_FINAL_TOKENS = "key|keys|token|password|passwd|passphrase|credential|credentials";

/**
 * Matches a sensitive INI `key = value` line, capturing `key + separator` so the
 * value alone is replaced and the key name survives for drift detection.
 *
 * A key is sensitive when it contains a credential word (SECRET_KEY_WORDS) or
 * ends in one (SECRET_FINAL_TOKENS), UNLESS its final token marks it as policy or
 * path (NON_SECRET_FINAL_TOKENS). Verified against a real gpudb.conf: an
 * enumerated `license_key|private_key` set missed `ai.api.key`, while matching
 * `password` by position alone missed `private_key_pem`.
 *
 * `src/tools/audit-redact.ts` guards the same secrets by fingerprinting the whole
 * config_string instead; it needs no matching token list.
 */
const KEY_CHARS = "A-Za-z0-9_.-";

/**
 * Sensitive assignment matcher, built from the sets above.
 *
 * Deliberately NOT line-anchored: reports carry prose, tool error text and JSON,
 * so a sensitive assignment can appear mid-line. The lookbehind finds the start
 * of a key name instead, which also stops a match beginning mid-key (the
 * "password_length" inside "min_password_length").
 *
 * Group 1 is `key + separator`, so the value alone is replaced.
 */
export const CONFIG_SECRET_PATTERN = new RegExp(
  `(?<![${KEY_CHARS}])(` +
    // leading space and any opening quote come first, so both exemptions below
    // are evaluated at the real start of the key name
    `[ \\t]*["']?` +
    // exemption 1: final token marks the key as policy or path
    `(?![${KEY_CHARS}]*[_.](?:${NON_SECRET_FINAL_TOKENS})["']?[ \\t]*[:=])` +
    // exemption 2: the LAST dotted segment starts with a boolean-flag word --
    // tier.cold0.default.use_managed_credentials is a flag, while
    // tier.use_backup.default.s3_aws_secret_access_key is not
    `(?!(?:[${KEY_CHARS}]*\\.)?(?:${FLAG_LEADING_TOKENS})_[^.]*["']?[ \\t]*[:=])` +
    `(?:` +
    // a credential word anywhere in the key name
    `[${KEY_CHARS}]*(?:${SECRET_KEY_WORDS})[${KEY_CHARS}]*` +
    // or the final token itself is a credential word
    `|[${KEY_CHARS}]*[_.](?:${SECRET_FINAL_TOKENS})` +
    `)["']?[ \\t]*[:=][ \\t]*` +
    // non-whitespace value required: "[REDACTED]" on an empty field would imply
    // a credential that is not configured
    `)\\S[^\\r\\n]*`,
  "gi",
);

/**
 * Is this config key name's value a credential?
 *
 * The structured counterpart to {@link CONFIG_SECRET_PATTERN}, for callers that
 * already have parsed `{key, value}` entries (the bundle's gpudb.conf reader)
 * and should not have to render a line and re-parse it. Same three rules, same
 * token sets, so the text and structured paths cannot drift apart.
 *
 * Pure, never throws.
 */
export function isSecretConfigKey(key: string): boolean {
  const tokens = key.split(/[_.]/).filter((t) => t.length > 0);
  if (tokens.length === 0) return false;

  const last = tokens[tokens.length - 1].toLowerCase();
  if (new RegExp(`^(?:${NON_SECRET_FINAL_TOKENS})$`, "i").test(last)) return false;

  // The flag word must begin the LAST dotted segment: tier.cold0.default.
  // use_managed_credentials is a flag, but tier.use_backup.default.
  // s3_aws_secret_access_key is a credential that merely sits under one.
  const lastSegment = key.split(".").pop() ?? "";
  const segmentHead = (lastSegment.split("_")[0] ?? "").toLowerCase();
  if (new RegExp(`^(?:${FLAG_LEADING_TOKENS})$`, "i").test(segmentHead)) return false;

  if (new RegExp(`(?:${SECRET_KEY_WORDS})`, "i").test(key)) return true;
  return new RegExp(`^(?:${SECRET_FINAL_TOKENS})$`, "i").test(last);
}

/**
 * Loose matcher for report PROSE, used by {@link scrubCredentials} only.
 *
 * The two callers want opposite things. {@link redactConfigSecrets} runs over
 * gpudb.conf, where over-redaction hides diagnostics, so it demands the key and
 * separator be adjacent. Report text has the inverse trade -- a miss writes a
 * credential to disk, over-redaction costs nothing -- and the agent's idiom is
 * `**key**:` or `` `key` = ``, not bare INI. One pattern cannot serve both; a
 * single precise pattern silently stopped redacting every decorated form.
 *
 * Shape is deliberately the pre-rewrite pattern (arbitrary non-separator
 * decoration around the credential word) so prose coverage is provably no worse
 * than before, with the wider vocabulary added and `|` accepted as a separator
 * so a credential in a report's before/after TABLE is covered too. Bare `key`/`token` suffixes are
 * NOT included here: unbounded matching on them would redact any report line
 * containing the word "key".
 */
const PROSE_SECRET_PATTERN = new RegExp(
  `([^\\r\\n=:|]*(?:${SECRET_KEY_WORDS})[^\\r\\n=:|]*[:=|][ \\t]*)[^\\r\\n]+`,
  "gi",
);

/**
 * Masks sensitive INI values, preserving key names. Unlike {@link
 * scrubCredentials} it leaves non-secret lines intact, so show_configuration can
 * still return a usable config blob for drift detection.
 */
export function redactConfigSecrets(content: string): string {
  return content.replace(CONFIG_SECRET_PATTERN, "$1[REDACTED]");
}

/**
 * Default patterns for credential scrubbing.
 * Each pattern matches a specific credential format and is replaced with "[REDACTED]".
 *
 * Patterns covered:
 * - HTTP/HTTPS URLs (Kinetica endpoints)
 * - Basic auth header values (Base64-encoded credentials)
 * - Bearer token values
 * - Password key-value pairs (bare `password: value` form)
 * - JSON `"password": "value"` form (quoted, used by APIs and config blobs)
 * - Generic API-key / access-token / secret key-value pairs
 * - Cookie / Set-Cookie headers (opaque session material)
 * - Authorization header values
 */
export const DEFAULT_SCRUB_PATTERNS: readonly RegExp[] = [
  /https?:\/\/[^\s"'`)\]]+/gi, // HTTP/HTTPS URLs
  /Basic\s+[A-Za-z0-9+/=]+/gi, // Basic auth headers
  /Bearer\s+[A-Za-z0-9._-]+/gi, // Bearer tokens
  /password[:\s]+[^\s"'`)\]]+/gi, // Password values (bare form: password: value)
  /"password"\s*:\s*"[^"]*"/gi, // JSON form: "password":"..."
  /(api[_-]?key|access[_-]?token|secret)["']?\s*[:=]\s*['"]?[^\s"'`)\]&,;]+/gi, // api_key / access_token / secret
  /(set-)?cookie\s*:\s*[^\r\n]+/gi, // Cookie / Set-Cookie headers
  /Authorization[:\s]+[^\s"'`)\]]+/gi, // Authorization header values
] as const;

/**
 * Scrubs credentials from content by replacing matches with "[REDACTED]".
 *
 * Pure function — returns a new string without mutating the input. First runs
 * {@link redactConfigSecrets} to mask the values of sensitive INI `key = value`
 * lines (the gpudb.conf case, where a bare keyword match would otherwise leave
 * the value intact), then reduces over the provided patterns, applying each
 * replacement in sequence. The config-secret pass always runs — it is a
 * security control, so masking more is strictly safer even with custom patterns.
 *
 * @param content - The string to scrub (report markdown, log output, etc.)
 * @param patterns - Optional custom patterns array; defaults to DEFAULT_SCRUB_PATTERNS
 * @returns A new string with all credential patterns replaced by "[REDACTED]"
 */
export function scrubCredentials(
  content: string,
  patterns: readonly RegExp[] = DEFAULT_SCRUB_PATTERNS,
): string {
  const configRedacted = redactConfigSecrets(content);
  const proseRedacted = configRedacted.replace(PROSE_SECRET_PATTERN, "$1[REDACTED]");
  return patterns.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), proseRedacted);
}
