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
 * Matches a sensitive INI `key = value` / `key: value` line and captures the
 * `key + separator` portion (group 1) so the value can be replaced while the key
 * name is preserved (e.g. `license_key = [REDACTED]`).
 *
 * The sensitive keyword may appear anywhere inside the key token, so dotted /
 * prefixed keys such as `security.ldap_bind_password` are covered. Matching is
 * intentionally broad over the key (any key containing one of these keywords is
 * treated as sensitive) — erring toward redaction for config blobs like
 * gpudb.conf, which carry license keys, LDAP bind passwords, and TLS keystore /
 * truststore passwords. The value is consumed to end-of-line so the entire
 * secret is removed, not just its first token.
 *
 * Keep the keyword set in sync with the sensitive-key handling in
 * `src/tools/audit-redact.ts` — both guard the same gpudb.conf secrets (the two
 * use different strategies: masked-line here vs. whole-blob fingerprint there).
 */
export const CONFIG_SECRET_PATTERN =
  /([^\r\n=:]*(?:password|passwd|passphrase|license[_-]?key|private[_-]?key|secret)[^\r\n=:]*[:=][ \t]*)[^\r\n]+/gi;

/**
 * Masks the values of sensitive INI keys while preserving the key name.
 *
 * Pure function — returns a new string without mutating the input. Unlike
 * {@link scrubCredentials}, this only touches sensitive `key = value` lines and
 * leaves all other configuration intact, so callers (e.g. the show_configuration
 * tool) can return a still-useful config blob to the agent for drift detection
 * with every secret value masked.
 *
 * @param content - INI-format config text (or any text containing such lines)
 * @returns A new string with sensitive values replaced by "[REDACTED]"
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
  return patterns.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), configRedacted);
}
